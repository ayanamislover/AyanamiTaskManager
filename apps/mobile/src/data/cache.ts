/**
 * IndexedDB 里的本地缓存：最近一次快照（离线可看）和命令队列（重启后继续等回执）。
 * 一个库、一张 key-value 表；值都是结构化克隆，不做 JSON 序列化。
 * 打不开（隐私模式、存储被清）时一律降级为「没有缓存」，不影响在线使用。
 */
const DB_NAME = "atm-mobile";
const STORE = "kv";

let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (opening) return opening;
  opening = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE))
          request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

function run<T>(
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return open().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const transaction = db.transaction(STORE, mode);
          const request = body(transaction.objectStore(STORE));
          transaction.oncomplete = () => resolve(request.result ?? null);
          transaction.onerror = () => resolve(null);
          transaction.onabort = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

export function cacheGet<T>(key: string): Promise<T | null> {
  return run<T>("readonly", (store) => store.get(key) as IDBRequest<T>);
}

export async function cachePut(key: string, value: unknown): Promise<void> {
  await run("readwrite", (store) => store.put(value, key));
}

export async function cacheClear(): Promise<void> {
  await run("readwrite", (store) => store.clear());
}

/** 同一个键的连续写入只落最后一次。 */
export function debouncedWriter(key: string, delayMs: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest: unknown;
  const flush = async () => {
    if (timer) clearTimeout(timer);
    timer = null;
    await cachePut(key, latest);
  };
  return {
    write(value: unknown) {
      latest = value;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void flush(), delayMs);
    },
    flush: () => (timer ? flush() : Promise.resolve()),
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

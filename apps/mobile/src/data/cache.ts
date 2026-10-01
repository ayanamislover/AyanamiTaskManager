/**
 * IndexedDB 里的本地缓存：最近一次快照（离线可看）和命令队列（重启后继续等回执）。
 * 一个库、一张 key-value 表；值都是结构化克隆，不做 JSON 序列化。
 * 读不到（隐私模式、存储被清）时降级为「没有缓存」；写入则如实报告成败——
 * 快照写失败可以忽略，命令队列写失败不能当成已保存（见 cachePut）。
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

type Outcome<T> = { ok: true; value: T | null } | { ok: false };

function run<T>(
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<Outcome<T>> {
  return open().then(
    (db) =>
      new Promise<Outcome<T>>((resolve) => {
        if (!db) return resolve({ ok: false });
        try {
          const transaction = db.transaction(STORE, mode);
          const request = body(transaction.objectStore(STORE));
          transaction.oncomplete = () => resolve({ ok: true, value: request.result ?? null });
          transaction.onerror = () => resolve({ ok: false });
          transaction.onabort = () => resolve({ ok: false });
        } catch {
          resolve({ ok: false });
        }
      }),
  );
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  const outcome = await run<T>("readonly", (store) => store.get(key) as IDBRequest<T>);
  return outcome.ok ? outcome.value : null;
}

/** 写入并在事务提交后返回 true；库打不开、事务出错或被中止都返回 false。 */
export async function cachePut(key: string, value: unknown): Promise<boolean> {
  return (await run("readwrite", (store) => store.put(value, key))).ok;
}

export async function cacheClear(): Promise<boolean> {
  return (await run("readwrite", (store) => store.clear())).ok;
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

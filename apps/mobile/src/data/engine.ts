import {
  RelayError,
  backoffDelay,
  classifyKey,
  isSyncProtocolError,
  newCommandId,
  type CommandDoc,
  type CommandInput,
  type PairingPayload,
  type RelayChange,
  type RevokedDoc,
} from "@ayanami-task/sync-protocol";
import type { SyncBackend } from "./backend.js";
import { cacheGet, cachePut, debouncedWriter } from "./cache.js";
import {
  acksToClear,
  commandsAwaitingAck,
  commandsToSend,
  reduceCommands,
  restoreCommands,
  type CommandEvent,
  type LocalCommand,
} from "./commands.js";
import {
  applyHead,
  applyProject,
  dropProjectByHash,
  emptySnapshot,
  projectHeadByHash,
  projectsToFetch,
  snapshotScope,
  type Snapshot,
} from "./snapshot.js";

/** 配对信息：配对码的内容 + 本机设备身份。token 与 secret 只存在原生安全存储和引擎里。 */
export type Pairing = PairingPayload & { deviceId: string; deviceName: string; pairedAt: string };

export type SyncPhase =
  /** 还没开始，或 App 在后台（后台不轮询）。 */
  | "idle"
  | "connecting"
  | "live"
  /** 连不上中继，按退避重试中。 */
  | "offline"
  /** 中继拒绝了 token：重试没有意义，需要重新配对。 */
  | "denied"
  /** 配对密钥对不上或电脑已重置配对：需要重新配对。 */
  | "rekey";

export type EngineState = {
  loaded: boolean;
  phase: SyncPhase;
  snapshot: Snapshot;
  commands: LocalCommand[];
  longPoll: boolean;
  refreshing: boolean;
  /** 给用户看的最近一次错误。 */
  lastError: string | null;
  retryAt: number | null;
};

const DEVICE_HEARTBEAT_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 30_000;

type Failure = { fatal: "denied" | "rekey" | null; message: string; retryAfterMs: number | null };

export function describeFailure(error: unknown): Failure {
  if (error instanceof RelayError) {
    if (error.isAuthFailure) {
      return {
        fatal: "denied",
        message:
          "中继不再接受这台手机的 token，可能已在电脑上被吊销。请在电脑 ATM「设置 → 手机同步」重新获取配对码。",
        retryAfterMs: null,
      };
    }
    if (error.status === 0) {
      return { fatal: null, message: "连不上中继，检查一下网络", retryAfterMs: null };
    }
    if (error.status === 429) {
      return {
        fatal: null,
        message: "请求太频繁，中继让稍后再试",
        retryAfterMs: error.retryAfter ? error.retryAfter * 1000 : null,
      };
    }
    return { fatal: null, message: `中继出错：${error.message}`, retryAfterMs: null };
  }
  if (isSyncProtocolError(error)) {
    if (error.code === "KEY_MISMATCH" || error.code === "DECRYPT_FAILED") {
      return { fatal: "rekey", message: error.message, retryAfterMs: null };
    }
    return { fatal: null, message: error.message, retryAfterMs: null };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { fatal: null, message: `同步出错：${message}`, retryAfterMs: null };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export type EngineOptions = {
  backend: SyncBackend;
  pairing: Pairing;
  appVersion: string;
  now?: () => number;
};

/**
 * 手机侧同步引擎：缓存 → 连接 → 全量读一次 → 跟变更流（长轮询或 3 s 轮询）。
 * App 进后台时 pause()，回前台 start()；下拉刷新 refresh() 打断当前等待立刻全量重读。
 */
export class SyncEngine {
  readonly #backend: SyncBackend;
  readonly #pairing: Pairing;
  readonly #appVersion: string;
  readonly #now: () => number;
  readonly #listeners = new Set<() => void>();
  readonly #snapshotWriter = debouncedWriter("snapshot", 400);
  #state: EngineState;
  #running = false;
  #connected = false;
  #forceFull = true;
  #failures = 0;
  #controller: AbortController | null = null;
  #lastDeviceWrite = 0;
  #loop: Promise<void> | null = null;

  constructor(options: EngineOptions) {
    this.#backend = options.backend;
    this.#pairing = options.pairing;
    this.#appVersion = options.appVersion;
    this.#now = options.now ?? Date.now;
    this.#state = {
      loaded: false,
      phase: "idle",
      snapshot: emptySnapshot(options.backend.spaceId, snapshotScope(options.pairing)),
      commands: [],
      longPoll: false,
      refreshing: false,
      lastError: null,
      retryAt: null,
    };
  }

  get pairing(): Pairing {
    return this.#pairing;
  }

  getState = (): EngineState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #set(patch: Partial<EngineState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }

  #setSnapshot(snapshot: Snapshot): void {
    if (snapshot === this.#state.snapshot) return;
    this.#set({ snapshot });
    this.#snapshotWriter.write(snapshot);
  }

  async #dispatch(event: CommandEvent): Promise<void> {
    const commands = reduceCommands(this.#state.commands, event);
    if (commands === this.#state.commands) return;
    this.#set({ commands });
    // 命令队列小，直接写；发送之前必须已经落盘。
    await cachePut("commands", commands);
  }

  /**
   * 读本地缓存。快照（含变更游标）只在「中继 + 应用 + 空间」完全一致时采用：
   * 换了任何一项，旧游标拿到新中继上会被拒（400），旧快照也不是这份数据。
   */
  async load(): Promise<void> {
    const [snapshot, commands] = await Promise.all([
      cacheGet<Snapshot>("snapshot"),
      cacheGet<unknown>("commands"),
    ]);
    const usable = snapshot && snapshot.scope === this.#state.snapshot.scope ? snapshot : null;
    let restored = restoreCommands(commands).filter(
      (command) => command.doc.device.id === this.#pairing.deviceId,
    );
    restored = reduceCommands(restored, { type: "expire", now: this.#now() });
    restored = reduceCommands(restored, { type: "prune", now: this.#now() });
    this.#set({ loaded: true, snapshot: usable ?? this.#state.snapshot, commands: restored });
  }

  start(): void {
    if (this.#running) return;
    if (this.#state.phase === "denied" || this.#state.phase === "rekey") return;
    this.#running = true;
    this.#forceFull = true;
    this.#set({ phase: this.#state.snapshot.syncedAt ? this.#state.phase : "connecting" });
    this.#loop = this.#run().finally(() => {
      this.#loop = null;
    });
  }

  /** 进后台：停止轮询，尽量告诉电脑这台手机下线了。 */
  pause(): void {
    if (!this.#running) return;
    this.#running = false;
    this.#controller?.abort();
    this.#set({ phase: "idle", refreshing: false });
    void this.#snapshotWriter.flush();
    if (this.#connected) void this.#writeOwnDevice("offline").catch(() => undefined);
    // 回前台时重新报一次在线（刚才写的是 offline）。
    this.#lastDeviceWrite = 0;
  }

  refresh(): void {
    if (this.#state.phase === "denied" || this.#state.phase === "rekey") return;
    this.#forceFull = true;
    this.#set({ refreshing: true });
    if (!this.#running) this.start();
    else this.#controller?.abort();
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#controller?.abort();
    await this.#loop;
    await this.#snapshotWriter.flush();
  }

  /** 发命令：先落盘，再让循环去发。返回本地命令 ID。 */
  async submit(input: CommandInput): Promise<string> {
    const doc = {
      v: 1,
      id: newCommandId(this.#pairing.deviceId, this.#now()),
      device: { id: this.#pairing.deviceId, name: this.#pairing.deviceName },
      at: new Date(this.#now()).toISOString(),
      ...input,
    } as CommandDoc;
    await this.#dispatch({ type: "enqueue", doc });
    this.#backend.poke();
    if (this.#running) this.#controller?.abort();
    else this.start();
    return doc.id;
  }

  async dismiss(id: string): Promise<void> {
    await this.#dispatch({ type: "dismiss", id });
    await this.#dispatch({ type: "prune", now: this.#now() });
  }

  async #run(): Promise<void> {
    while (this.#running) {
      const controller = new AbortController();
      this.#controller = controller;
      try {
        if (!this.#connected) {
          const { longPoll } = await this.#backend.connect(this.#state.snapshot.cursor);
          this.#connected = true;
          this.#forceFull = true;
          this.#set({ longPoll });
          await this.#writeOwnDevice("online").catch(() => undefined);
        }
        if (this.#forceFull) {
          this.#forceFull = false;
          await this.#fullSync();
          // 读到撤销标记：已经停下并标成 rekey，不能再往下走（#markLive 会把它盖回 live）。
          if (!this.#running) break;
        }
        await this.#flushOutbox();
        this.#markLive();
        if (this.#now() - this.#lastDeviceWrite > DEVICE_HEARTBEAT_MS) {
          await this.#writeOwnDevice("online").catch(() => undefined);
        }
        if (controller.signal.aborted) continue;
        const batch = await this.#backend.nextChanges(controller.signal);
        if (batch.reset) {
          this.#forceFull = true;
        } else {
          await this.#applyChanges(batch.changes);
          if (!this.#running) break;
        }
        this.#setSnapshot({ ...this.#state.snapshot, cursor: batch.cursor });
        this.#markLive();
      } catch (error) {
        if (!this.#running) break;
        // 刷新或新命令打断了等待：不算失败，直接进入下一轮。
        if (controller.signal.aborted) continue;
        const failure = describeFailure(error);
        if (failure.fatal) {
          this.#running = false;
          this.#set({
            phase: failure.fatal,
            lastError: failure.message,
            refreshing: false,
            retryAt: null,
          });
          break;
        }
        this.#failures += 1;
        this.#connected = false;
        const delay = Math.min(
          MAX_BACKOFF_MS,
          failure.retryAfterMs ?? backoffDelay(this.#failures),
        );
        this.#set({
          phase: "offline",
          lastError: failure.message,
          refreshing: false,
          retryAt: this.#now() + delay,
        });
        await sleep(delay, controller.signal);
      }
    }
    this.#controller = null;
  }

  #markLive(): void {
    this.#failures = 0;
    const patch: Partial<EngineState> = {};
    if (this.#state.phase !== "live") patch.phase = "live";
    if (this.#state.lastError) patch.lastError = null;
    if (this.#state.retryAt) patch.retryAt = null;
    if (this.#state.refreshing) patch.refreshing = false;
    if (Object.keys(patch).length > 0) this.#set(patch);
    this.#setSnapshot({ ...this.#state.snapshot, syncedAt: new Date(this.#now()).toISOString() });
  }

  async #writeOwnDevice(state: "online" | "offline"): Promise<void> {
    this.#lastDeviceWrite = this.#now();
    await this.#backend.writeDevice({
      v: 1,
      id: this.#pairing.deviceId,
      name: this.#pairing.deviceName,
      kind: "android",
      role: "client",
      app: `atm-mobile/${this.#appVersion}`.slice(0, 32),
      at: new Date(this.#now()).toISOString(),
      state,
    });
  }

  /**
   * 这个空间已经作废（电脑重置了配对）：停下循环，等用户重新扫码。
   * 不再写心跳，也不再发命令——发进旧空间的命令没有人会读。
   */
  #revoke(revoked: RevokedDoc | null): void {
    this.#running = false;
    const host = revoked?.host.name.trim();
    this.#set({
      phase: "rekey",
      lastError: `${host ? `电脑「${host}」` : "电脑端"}已经重置了配对，这台手机需要重新扫码`,
      refreshing: false,
      retryAt: null,
    });
  }

  async #fullSync(): Promise<void> {
    const head = await this.#backend.readHead();
    if (!head) {
      // 空间里没有头部：电脑还没发布过，或者已经重置了配对。后者会留下撤销标记，据此区分。
      const revoked = await this.#backend.readRevoked();
      if (revoked) return this.#revoke(revoked);
      this.#setSnapshot({ ...this.#state.snapshot, head: null, projects: {}, host: null });
    } else {
      this.#setSnapshot(applyHead(this.#state.snapshot, head));
      await this.#fetchProjects(projectsToFetch(this.#state.snapshot).map((project) => project.h));
      const host = await this.#backend.readDevice(head.host.id);
      this.#setSnapshot({ ...this.#state.snapshot, host });
    }
    await this.#checkAcks(commandsAwaitingAck(this.#state.commands).map((c) => c.doc.id));
    await this.#clearAcks();
  }

  async #fetchProjects(hashes: Iterable<string>): Promise<void> {
    for (const hash of new Set(hashes)) {
      const head = projectHeadByHash(this.#state.snapshot, hash);
      if (!head) continue;
      const doc = await this.#backend.readProject(hash);
      this.#setSnapshot(
        doc
          ? applyProject(this.#state.snapshot, head, doc)
          : dropProjectByHash(this.#state.snapshot, hash),
      );
    }
  }

  async #flushOutbox(): Promise<void> {
    for (const command of commandsToSend(this.#state.commands)) {
      try {
        await this.#backend.writeCommand(command.doc);
        await this.#dispatch({
          type: "send-ok",
          id: command.doc.id,
          at: new Date(this.#now()).toISOString(),
        });
      } catch (error) {
        await this.#dispatch({
          type: "send-error",
          id: command.doc.id,
          message: describeFailure(error).message,
        });
        throw error;
      }
    }
    await this.#dispatch({ type: "expire", now: this.#now() });
  }

  async #checkAcks(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const ack = await this.#backend.readAck(id);
      if (!ack) continue;
      await this.#dispatch({ type: "ack", ack });
    }
  }

  async #clearAcks(): Promise<void> {
    for (const command of acksToClear(this.#state.commands)) {
      await this.#backend.deleteAck(command.doc.id);
      await this.#dispatch({ type: "ack-cleared", id: command.doc.id });
    }
    await this.#dispatch({ type: "prune", now: this.#now() });
  }

  async #applyChanges(changes: readonly RelayChange[]): Promise<void> {
    const spaceId = this.#backend.spaceId;
    const awaiting = new Set(commandsAwaitingAck(this.#state.commands).map((c) => c.doc.id));
    let headChanged = false;
    let revokedChanged = false;
    let hostChanged = false;
    const projectHashes = new Set<string>();
    const acks = new Set<string>();
    for (const change of changes) {
      const key = classifyKey(spaceId, change.key);
      // 分片的第 0 片最后写（提交点），所以只看第 0 片的变更就够了。
      if (!key || key.part > 0) continue;
      switch (key.kind) {
        case "head":
          headChanged = true;
          break;
        case "revoked":
          if (change.op === "put") revokedChanged = true;
          break;
        case "project":
          if (change.op === "delete")
            this.#setSnapshot(dropProjectByHash(this.#state.snapshot, key.hash));
          else projectHashes.add(key.hash);
          break;
        case "ack":
          if (change.op === "put" && awaiting.has(key.id)) acks.add(key.id);
          break;
        case "device":
          if (key.id === this.#state.snapshot.head?.host.id) hostChanged = true;
          break;
        case "command":
          break;
      }
    }
    if (revokedChanged) {
      // 以能解开的标记为准：解不开会抛 DECRYPT_FAILED，同样按 rekey 处理。
      const revoked = await this.#backend.readRevoked();
      if (revoked) return this.#revoke(revoked);
    }
    if (headChanged) {
      const head = await this.#backend.readHead();
      if (!head) {
        // 头部被删只会发生在重置配对清空旧空间时；撤销标记随后才写，这里先按作废处理。
        return this.#revoke(await this.#backend.readRevoked().catch(() => null));
      }
      this.#setSnapshot(applyHead(this.#state.snapshot, head));
      for (const project of projectsToFetch(this.#state.snapshot)) projectHashes.add(project.h);
    }
    await this.#fetchProjects(projectHashes);
    if (hostChanged && this.#state.snapshot.head) {
      const host = await this.#backend.readDevice(this.#state.snapshot.head.host.id);
      this.#setSnapshot({ ...this.#state.snapshot, host });
    }
    if (acks.size > 0) {
      await this.#checkAcks([...acks]);
      await this.#clearAcks();
    }
  }
}

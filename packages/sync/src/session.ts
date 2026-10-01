import type { AyanamiTaskService } from "@ayanami-task/application";
import {
  COMMAND_MAX_AGE_MS,
  ChangeFeed,
  PROJECT_CODE_PATTERN,
  RelayClient,
  RelayError,
  SpaceStore,
  SyncProtocolError,
  classifyKey,
  commandTimestamp,
  deriveSpaceKeys,
  type AckDoc,
  type CommandDoc,
  type DeviceDoc,
  type FetchLike,
  type RelayChange,
  type RelayProbe,
} from "@ayanami-task/sync-protocol";
import { executeCommand, isRetryableCommandError, validateCommand } from "./commands.js";
import { rememberProcessed, type PublishedProject, type SyncConfig } from "./config.js";
import type { DispatchPort } from "./dispatch-port.js";
import { ackError, describeError } from "./errors.js";
import type { SyncLogger } from "./logger.js";
import { buildHeadBody, buildProjectSnapshot, clipText, projectHeadOf } from "./snapshot.js";

export type { SyncLogger };

/** 状态接口里的「已配对设备」：设备自己写的在线状态文档去掉版本号 `v`。 */
export type DeviceView = Omit<DeviceDoc, "v">;

/** 连接器提供给会话的能力。配置修改只对当前会话生效：换空间后旧会话迟到的写入会被丢弃。 */
export type SessionHost = {
  readonly service: AyanamiTaskService;
  readonly dispatch: DispatchPort | null;
  readonly appVersion: string;
  readonly logger: SyncLogger;
  now(): Date;
  config(): SyncConfig;
  commit(session: SyncSession, mutate: (config: SyncConfig) => SyncConfig): void;
  onDevices(devices: DeviceView[]): void;
  onPending(count: number): void;
};

export type SessionOptions = {
  relayUrl: string;
  appId: string;
  token: string;
  spaceId: string;
  secret: string;
  fetchImpl?: FetchLike;
  /** 不支持长轮询的中继（AyanamiCloud）多久问一次，电脑默认 4 s。 */
  pollIntervalMs: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

/** 可重试的命令最多试几次，之后写失败 ack。 */
const COMMAND_ATTEMPTS = 5;
const ACK_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const HEAD_PROJECT_LIMIT = 500;

/**
 * 一次与中继的连接：一个空间、一份密钥、一条变更流。
 * 所有写操作由连接器串行调用（同一时刻只有一个在跑）。
 */
export class SyncSession {
  readonly client: RelayClient;
  readonly store: SpaceStore;
  readonly probe: RelayProbe;
  readonly #host: SessionHost;
  readonly #options: SessionOptions;
  readonly #pending = new Map<string, number>();
  #devices = new Map<string, DeviceDoc>();
  #feed: ChangeFeed;
  /** 游标被中继判为无效后重建了变更流：下一次全量重同步必须重写全部快照。 */
  #forceResync = false;

  private constructor(
    host: SessionHost,
    options: SessionOptions,
    parts: { client: RelayClient; store: SpaceStore; probe: RelayProbe },
  ) {
    this.#host = host;
    this.#options = options;
    this.client = parts.client;
    this.store = parts.store;
    this.probe = parts.probe;
    this.#feed = this.#newFeed(host.config().cursor);
  }

  /** 探测中继、派生密钥、建立变更流。探测失败直接抛（由连接器决定退避还是停止）。 */
  static async open(host: SessionHost, options: SessionOptions): Promise<SyncSession> {
    const client = new RelayClient({
      baseUrl: options.relayUrl,
      appId: options.appId,
      token: options.token,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    const probe = await client.probe();
    const keys = await deriveSpaceKeys(options.secret);
    const store = new SpaceStore({ client, keys, spaceId: options.spaceId });
    return new SyncSession(host, options, { client, store, probe });
  }

  #newFeed(cursor: string | null): ChangeFeed {
    return new ChangeFeed({
      client: this.client,
      spaceId: this.#options.spaceId,
      cursor,
      longPoll: this.probe.longPoll,
      ...(this.probe.maxWait > 0 ? { maxWait: this.probe.maxWait } : {}),
      intervalMs: this.#options.pollIntervalMs,
      ...(this.#options.sleep ? { sleep: this.#options.sleep } : {}),
    });
  }

  get feed(): ChangeFeed {
    return this.#feed;
  }

  /**
   * 中继不认保存的游标（例如 atm-relay 与 AyanamiCloud 的游标格式互不通用，回 400）：
   * 丢掉游标从头建变更流，下一次全量重同步强制重写。
   */
  resetFeed(): void {
    this.#feed = this.#newFeed(null);
    this.#forceResync = true;
  }

  get spaceId(): string {
    return this.store.spaceId;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  /** 其它设备（不含本机），按最后在线时间倒序。 */
  devices(): DeviceView[] {
    return [...this.#devices.values()]
      .map(({ id, name, kind, role, app, at, state }) => ({ id, name, kind, role, app, at, state }))
      .sort((left, right) => right.at.localeCompare(left.at));
  }

  // ─── 整体流程 ───

  /** 连上以后：报在线 → 读设备 → 兜底处理漏掉的命令 → 发布（摘要不变不写）→ 按天清旧回执。 */
  async initialSync(): Promise<void> {
    await this.writePresence("online");
    await this.refreshDevices();
    await this.scanCommands();
    await this.processPending();
    await this.publish("all");
    await this.sweepAcksIfDue();
  }

  /**
   * 变更流重来（游标过期 410 或第一次拿到游标）：重读设备与命令、重建全部快照。
   * `force` 时不管摘要一律重写（游标过期期间中继上的数据可能丢了）。
   */
  async fullResync(options: { force: boolean }): Promise<void> {
    const force = options.force || this.#forceResync;
    await this.refreshDevices();
    await this.scanCommands();
    await this.processPending();
    await this.publish("all", { force });
    this.#forceResync = false;
  }

  /** 每 5 分钟：报在线、刷新设备、按天清旧回执。 */
  async presenceTick(): Promise<void> {
    await this.writePresence("online");
    await this.refreshDevices();
    await this.sweepAcksIfDue();
  }

  async applyChanges(changes: readonly RelayChange[]): Promise<void> {
    const ownId = this.#host.config().deviceId;
    for (const change of changes) {
      const key = classifyKey(this.spaceId, change.key);
      if (!key) continue;
      if (change.op === "delete") this.store.forget(change.key);
      if (key.part !== 0) continue;
      if (key.kind === "command" && change.op === "put") this.#enqueue(key.id);
      else if (key.kind === "device" && key.id !== ownId) await this.#onDevice(key.id, change.op);
    }
    await this.processPending();
  }

  // ─── 快照 ───

  /**
   * 重建受影响项目的快照，摘要变了才写；已不再活动的项目删掉；head 最后写。
   * `force` 用于游标过期后的全量重同步：不管摘要一律重写。
   */
  async publish(dirty: ReadonlySet<string> | "all", options: { force?: boolean } = {}) {
    const force = options.force === true;
    const host = this.#host;
    const now = host.now();
    const at = now.toISOString();
    const projects = host.service
      .listProjects()
      .filter(
        (project) => project.lifecycle === "ACTIVE" && PROJECT_CODE_PATTERN.test(project.code),
      );
    const written: string[] = [];
    const removed: string[] = [];
    for (const project of projects) {
      const previous = host.config().published[project.code];
      const renamed = previous !== undefined && previous.head.name !== clipText(project.name, 200);
      const wanted = force || dirty === "all" || dirty.has(project.code) || !previous || renamed;
      if (!wanted) continue;
      const snapshot = await buildProjectSnapshot(host.service, project, host.dispatch, now);
      if (!force && previous?.d === snapshot.digest) continue;
      const hash = await this.store.projectHash(project.code);
      await this.store.writeProject(hash, { ...snapshot.body, at });
      const entry: PublishedProject = {
        h: hash,
        d: snapshot.digest,
        head: projectHeadOf(snapshot, hash, at),
      };
      host.commit(this, (config) => ({
        ...config,
        published: { ...config.published, [project.code]: entry },
      }));
      written.push(project.code);
    }
    const live = new Set(projects.map((project) => project.code));
    for (const [code, entry] of Object.entries(host.config().published)) {
      if (live.has(code)) continue;
      await this.store.deleteProject(entry.h);
      host.commit(this, (config) => {
        const published = { ...config.published };
        delete published[code];
        return { ...config, published };
      });
      removed.push(code);
    }
    const headWritten = await this.#writeHead(at, force);
    return { written, removed, headWritten };
  }

  async #writeHead(at: string, force: boolean): Promise<boolean> {
    const host = this.#host;
    const config = host.config();
    const head = buildHeadBody({
      host: {
        id: config.deviceId,
        name: config.deviceName,
        app: clipText(host.appVersion, 32),
      },
      dispatch: host.dispatch?.summary() ?? { enabled: false, mode: "auto", running: 0 },
      projects: Object.values(config.published)
        .map((entry) => entry.head)
        .slice(0, HEAD_PROJECT_LIMIT),
    });
    if (!force && head.digest === config.headDigest) return false;
    await this.store.writeHead({ ...head.body, at });
    host.commit(this, (current) => ({ ...current, headDigest: head.digest }));
    return true;
  }

  // ─── 命令 ───

  #enqueue(commandId: string): void {
    if (!this.#pending.has(commandId)) this.#pending.set(commandId, 0);
    this.#host.onPending(this.#pending.size);
  }

  /** 列出空间里还在的命令，全部排进待处理（漏掉的变更、重启前没处理完的）。 */
  async scanCommands(): Promise<void> {
    for (const key of await this.store.listKeys("cmd")) {
      const classified = classifyKey(this.spaceId, key);
      if (classified?.kind === "command") this.#enqueue(classified.id);
    }
  }

  /** 逐条处理。中继错误原样抛出（连接器退避后重来），待处理的留着下次继续。 */
  async processPending(): Promise<void> {
    try {
      for (const [commandId, attempts] of [...this.#pending]) {
        const done = await this.#processCommand(commandId, attempts);
        if (done) this.#pending.delete(commandId);
        else this.#pending.set(commandId, attempts + 1);
      }
    } finally {
      this.#host.onPending(this.#pending.size);
    }
  }

  async #processCommand(commandId: string, attempts: number): Promise<boolean> {
    const host = this.#host;
    if (host.config().processed.includes(commandId)) {
      // 回执已经写过（上次删命令没成功，或中继把旧密文原样放了回来）：只补删，不再执行。
      await this.store.deleteCommand(commandId);
      return true;
    }
    let doc: CommandDoc | null;
    try {
      doc = await this.store.readCommand(commandId);
    } catch (error) {
      if (error instanceof RelayError) throw error;
      const incomplete = error instanceof SyncProtocolError && error.code === "OBJECT_INCOMPLETE";
      if (incomplete && attempts + 1 < COMMAND_ATTEMPTS) return false;
      await this.#finish(commandId, {
        v: 1,
        id: commandId,
        at: host.now().toISOString(),
        ok: false,
        error: { code: "COMMAND_UNREADABLE", message: describeError(error) },
      });
      return true;
    }
    if (!doc) return true;
    let ack: AckDoc;
    try {
      validateCommand(doc, commandId, host.now());
      const result = await executeCommand({ service: host.service, dispatch: host.dispatch }, doc);
      ack = { v: 1, id: commandId, at: host.now().toISOString(), ok: true, result };
      host.logger.info("已执行手机命令", { command: commandId, type: doc.type, key: result.key });
    } catch (error) {
      if (isRetryableCommandError(error) && attempts + 1 < COMMAND_ATTEMPTS) return false;
      const failure = ackError(error);
      ack = { v: 1, id: commandId, at: host.now().toISOString(), ok: false, error: failure };
      host.logger.warn("手机命令未执行", { command: commandId, code: failure.code });
    }
    await this.#finish(commandId, ack);
    return true;
  }

  /**
   * 先写回执、记下已处理，再删命令。回执写失败时命令留在待处理里、稍后整条重做：建任务靠 ATM 的
   * op_id（`mobile:<命令 ID>`）拿回同一个任务，派单靠派单层以命令 ID 为键的请求账本拿回同一次派单
   * （见 commands.ts），所以重做只会补写回执，不会再起一次 Claude。
   */
  async #finish(commandId: string, ack: AckDoc): Promise<void> {
    await this.store.writeAck(ack);
    const now = this.#host.now();
    this.#host.commit(this, (config) => rememberProcessed(config, commandId, now));
    await this.store.deleteCommand(commandId);
  }

  /** 每天一次：删掉 7 天前的回执（手机没来得及删的）。命令 ID 自带时间，不用解密。 */
  async sweepAcksIfDue(): Promise<void> {
    const host = this.#host;
    const now = host.now().getTime();
    const last = host.config().lastAckSweepAt;
    if (last && now - Date.parse(last) < ACK_SWEEP_INTERVAL_MS) return;
    for (const key of await this.store.listKeys("ack")) {
      const classified = classifyKey(this.spaceId, key);
      if (classified?.kind !== "ack") continue;
      const sentAt = commandTimestamp(classified.id);
      if (sentAt !== null && now - sentAt > COMMAND_MAX_AGE_MS)
        await this.store.deleteAck(classified.id);
    }
    host.commit(this, (config) => ({ ...config, lastAckSweepAt: new Date(now).toISOString() }));
  }

  // ─── 设备 ───

  async writePresence(state: "online" | "offline"): Promise<void> {
    const config = this.#host.config();
    await this.store.writeDevice({
      v: 1,
      id: config.deviceId,
      name: config.deviceName,
      kind: process.platform === "win32" ? "windows" : "other",
      role: "host",
      app: clipText(this.#host.appVersion, 32),
      at: this.#host.now().toISOString(),
      state,
    });
  }

  async refreshDevices(): Promise<void> {
    const ownId = this.#host.config().deviceId;
    const next = new Map<string, DeviceDoc>();
    for (const key of await this.store.listKeys("dev")) {
      const classified = classifyKey(this.spaceId, key);
      if (classified?.kind !== "device" || classified.id === ownId) continue;
      const doc = await this.#readDevice(classified.id);
      if (doc) next.set(doc.id, doc);
    }
    this.#devices = next;
    this.#host.onDevices(this.devices());
  }

  async #onDevice(deviceId: string, op: RelayChange["op"]): Promise<void> {
    const doc = op === "delete" ? null : await this.#readDevice(deviceId);
    if (doc) this.#devices.set(deviceId, doc);
    else this.#devices.delete(deviceId);
    this.#host.onDevices(this.devices());
  }

  async #readDevice(deviceId: string): Promise<DeviceDoc | null> {
    try {
      return await this.store.readDevice(deviceId);
    } catch (error) {
      if (error instanceof RelayError) throw error;
      // 解不开的设备文档（旧密钥、损坏）不算已配对设备。
      return null;
    }
  }
}

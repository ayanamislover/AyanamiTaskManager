import type { AyanamiTaskService } from "@ayanami-task/application";
import { AtmError } from "@ayanami-task/errors";
import {
  RelayClient,
  RelayError,
  backoffDelay,
  encodePairingCode,
  generateSpace,
  type FeedBatch,
} from "@ayanami-task/sync-protocol";
import { defaultDeviceName, loadSyncConfig, saveSyncConfig, type SyncConfig } from "./config.js";
import type { DispatchPort } from "./dispatch-port.js";
import { RELAY_REJECTED_MESSAGE, describeError, isAuthFailure } from "./errors.js";
import { PublishScheduler } from "./publish-scheduler.js";
import { SecretVault } from "./secret-store.js";
import { SyncSession, type DeviceView, type SessionHost, type SyncLogger } from "./session.js";
import {
  abortableSleep,
  measureProbe,
  parseRelayCandidate,
  planConfigChange,
  purgeSpace,
  revokeSpace,
  withTimeout,
} from "./settings.js";
import {
  DEFAULT_TIMINGS,
  type PairingResult,
  type RelayTestResult,
  type ResetSpaceResult,
  type SyncConnectorOptions,
  type SyncState,
  type SyncStatus,
  type SyncTimings,
} from "./types.js";

/**
 * 内部阶段，比对外的 state 细：对外 unconfigured / retrying / rejected / failed 都是 error，
 * stopped 是 disabled，原因写在 lastError。
 */
type Phase =
  | "disabled"
  | "unconfigured"
  | "connecting"
  | "online"
  | "retrying"
  | "rejected"
  | "failed"
  | "stopped";

const PUBLIC_STATE: Record<Phase, SyncState> = {
  disabled: "disabled",
  stopped: "disabled",
  connecting: "connecting",
  online: "online",
  unconfigured: "error",
  retrying: "error",
  rejected: "error",
  failed: "error",
};

const UNCONFIGURED_MESSAGE = "已启用手机同步，但还没有填写中继地址或 token";

type Loop = {
  controller: AbortController;
  promise: Promise<void>;
  session: SyncSession | null;
  /** 首次同步已完成，可以接受去抖发布与在线状态心跳。 */
  ready: boolean;
  /** 已经因为游标被拒（400）清过一次游标；再被拒就按普通错误处理。 */
  cursorRescued: boolean;
};

function isCursorRejected(error: unknown): boolean {
  return error instanceof RelayError && error.status === 400;
}

const silentLogger: SyncLogger = { info() {}, warn() {}, error() {} };

/**
 * 电脑侧同步连接器（docs/mobile-sync.md §7）。在 daemon 所在进程里运行，直接调用
 * AyanamiTaskService；只做出站 HTTPS。默认关闭，未启用时不联网。
 */
export class SyncConnector {
  readonly #options: SyncConnectorOptions;
  readonly #service: AyanamiTaskService;
  readonly #vault: SecretVault;
  readonly #dispatch: DispatchPort | null;
  readonly #logger: SyncLogger;
  readonly #now: () => Date;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #timings: SyncTimings;
  readonly #publisher: PublishScheduler;
  #config: SyncConfig;
  #phase: Phase = "disabled";
  #lastError: string | null = null;
  #longPoll: boolean | null = null;
  #devices: DeviceView[] = [];
  #pending = 0;
  #started = false;
  #loop: Loop | null = null;
  /** 对中继的写操作串行（发布、命令、在线状态不穿插）。 */
  #chain: Promise<unknown> = Promise.resolve();
  /** 设置页操作串行（改配置、配对、重置不并发）。 */
  #admin: Promise<unknown> = Promise.resolve();
  /** 正在建的配对空间：并发请求共用同一个，保证只建一次。 */
  #spaceCreation: Promise<void> | null = null;
  readonly #unsubscribers: Array<() => void> = [];

  constructor(options: SyncConnectorOptions) {
    this.#options = options;
    this.#service = options.service;
    this.#vault = new SecretVault(options.secrets);
    this.#dispatch = options.dispatch ?? null;
    this.#logger = options.logger ?? silentLogger;
    this.#now = options.now ?? (() => new Date());
    this.#sleep = options.sleep ?? abortableSleep;
    this.#timings = { ...DEFAULT_TIMINGS, ...options.timings };
    const deviceName = defaultDeviceName(options.deviceName);
    this.#config = loadSyncConfig(options.dataDir, this.#logger, deviceName);
    this.#publisher = new PublishScheduler({
      service: options.service,
      debounceMs: this.#timings.debounceMs,
      maxDelayMs: this.#timings.maxDelayMs,
      retryMs: this.#timings.retryPublishMs,
      ready: () => this.#readySession() !== null,
      publish: async (dirty) => {
        const session = this.#readySession();
        if (session) await this.#exclusive(() => session.publish(dirty));
      },
      failed: (error) => {
        const loop = this.#loop;
        if (!loop) return false;
        if (isAuthFailure(error)) {
          this.#reject(loop);
          return false;
        }
        this.#lastError = describeError(error);
        this.#logger.warn("发布快照失败，稍后重试", { error: this.#lastError });
        return true;
      },
    });
  }

  // ─── 生命周期 ───

  /** 读密钥、固定 deviceId、订阅进程内事件；已启用且配置齐全就开始同步。 */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    await this.#vault.load(this.#config.spaceId);
    this.#persist();
    this.#publisher.activate();
    const mark = (project: string | null) => this.#publisher.markDirty(project);
    this.#unsubscribers.push(this.#service.subscribeGlobal(() => mark(null)));
    if (this.#dispatch)
      this.#unsubscribers.push(this.#dispatch.onChange((event) => mark(event.project ?? null)));
    this.#launch();
  }

  /** 中断长轮询、写离线状态（有上限地等待），然后停下。 */
  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
    this.#publisher.stop();
    await this.#halt(true);
    this.#persist();
    this.#phase = "stopped";
  }

  /** 立刻发布积攒的变化、处理待办命令，并等它们做完（设置页「立即同步」与测试用）。 */
  async syncNow(): Promise<void> {
    await this.#publisher.flush();
    const session = this.#readySession();
    if (session) await this.#exclusive(() => session.processPending()).catch(() => undefined);
    await this.#chain;
  }

  async status(): Promise<SyncStatus> {
    await this.#vault.load(this.#config.spaceId);
    const phase = this.#started ? this.#phase : this.#idlePhase();
    const reason = this.#vault.loadError ?? this.#vault.unavailableReason();
    return {
      enabled: this.#config.enabled,
      configured: this.#configured(),
      relayUrl: this.#config.relayUrl,
      appId: this.#config.appId,
      deviceName: this.#config.deviceName,
      state: this.#started ? PUBLIC_STATE[phase] : "disabled",
      lastError:
        this.#lastError ?? reason ?? (phase === "unconfigured" ? UNCONFIGURED_MESSAGE : null),
      lastSyncAt: this.#config.lastSyncAt,
      longPoll: this.#longPoll,
      secretStore: this.#vault.statusKind,
      paired: this.#devices,
      pendingCommands: this.#pending,
    };
  }

  // ─── 设置页操作（串行） ───

  /** `{enabled?, relayUrl?, appId?, token?, deviceName?}`；token 只写不读，空字符串表示清除。 */
  updateConfig(patch: unknown): Promise<SyncStatus> {
    return this.#serialized(async () => {
      await this.#vault.load(this.#config.spaceId);
      const change = planConfigChange(this.#config, this.#vault.token, patch);
      if (change.token !== undefined) await this.#vault.setToken(change.token);
      this.#config = change.next;
      this.#persist();
      if (change.reconnect) {
        this.#lastError = null;
        await this.#halt(true);
        this.#launch();
      } else if (change.nameChanged) {
        this.#publisher.markDirty(null);
        const session = this.#readySession();
        if (session)
          void this.#exclusive(() => session.writePresence("online")).catch((error: unknown) => {
            this.#lastError = describeError(error);
          });
      }
      return this.status();
    });
  }

  /** 用给定或已存的配置探测中继并计时。连不上不抛错，结果里带中文原因。 */
  async testRelay(candidate?: unknown): Promise<RelayTestResult> {
    const input = parseRelayCandidate(candidate);
    if (!input) return { ok: false, latencyMs: 0, longPoll: false, error: "测试参数不合法" };
    await this.#vault.load(this.#config.spaceId);
    const relayUrl = input.relayUrl ?? this.#config.relayUrl;
    const appId = input.appId ?? this.#config.appId;
    const token = input.token ?? this.#vault.token;
    if (!relayUrl) return { ok: false, latencyMs: 0, longPoll: false, error: "还没有填写中继地址" };
    if (!token) return { ok: false, latencyMs: 0, longPoll: false, error: "还没有填写 token" };
    const result = await measureProbe(() => this.#client(relayUrl, appId, token));
    if (result.ok && relayUrl === this.#config.relayUrl && appId === this.#config.appId)
      this.#longPoll = result.longPoll;
    return result;
  }

  /**
   * 配对码（含中继 token 与空间密钥，只给设置页显示）。没有空间先建一个，并发请求也只建一次；
   * 已有空间就返回同一个配对码。
   */
  createPairing(): Promise<PairingResult> {
    return this.#serialized(async () => {
      await this.#vault.load(this.#config.spaceId);
      const relayUrl = this.#config.relayUrl;
      const token = this.#vault.token;
      if (!relayUrl || !token)
        throw new AtmError("VALIDATION_ERROR", {
          message: "请先填写中继地址和 token 并保存，再生成配对码",
        });
      await this.#ensureSpace();
      const { spaceId, appId, deviceName } = this.#config;
      const secret = this.#vault.secret;
      if (!spaceId || !secret)
        throw new AtmError("INTERNAL_ERROR", { message: "配对空间没有建好" });
      const pairingCode = encodePairingCode({
        v: 1,
        u: relayUrl,
        a: appId,
        t: token,
        s: spaceId,
        k: secret,
        n: deviceName,
      });
      return { pairingCode, spaceId };
    });
  }

  /**
   * 轮换空间：删掉旧空间里的文档（尽力而为），再留一条用旧密钥加密的撤销标记，
   * 然后换新空间与密钥。旧手机读到撤销标记就提示重新扫码。
   */
  resetSpace(): Promise<ResetSpaceResult> {
    return this.#serialized(async () => {
      await this.#vault.load(this.#config.spaceId);
      this.#vault.assertWritable();
      await this.#spaceCreation;
      const { spaceId: previous, relayUrl, appId, deviceId, deviceName } = this.#config;
      const token = this.#vault.token;
      const previousSecret = this.#vault.secret;
      await this.#halt(false);
      let removed = 0;
      const cleanupErrors: string[] = [];
      if (previous && relayUrl && token) {
        const client = this.#client(relayUrl, appId, token);
        try {
          removed = await purgeSpace(client, previous);
        } catch (error) {
          cleanupErrors.push(describeError(error));
          this.#logger.warn("清理旧配对空间失败", { error: describeError(error) });
        }
        // 撤销标记必须在清空之后写（先写会被一起删掉）；清理失败也照写，旧手机只认它。
        if (previousSecret) {
          try {
            const host = { id: deviceId, name: deviceName };
            await revokeSpace(client, previous, previousSecret, host, this.#now());
          } catch (error) {
            cleanupErrors.push(describeError(error));
            this.#logger.warn("写撤销标记失败", { error: describeError(error) });
          }
        }
      }
      const cleanupError = cleanupErrors.length > 0 ? cleanupErrors.join("；") : undefined;
      await this.#createSpace();
      this.#launch();
      const spaceId = this.#config.spaceId!;
      return { spaceId, removed, ...(cleanupError === undefined ? {} : { cleanupError }) };
    });
  }

  // ─── 内部：密钥、配置与空间 ───

  #serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#admin.then(task, task);
    this.#admin = run.catch(() => undefined);
    return run;
  }

  #persist(): void {
    saveSyncConfig(this.#options.dataDir, this.#config);
  }

  #configured(): boolean {
    return Boolean(this.#config.relayUrl && this.#config.appId && this.#vault.token);
  }

  /** 没有配对空间就建一个（单飞：同步循环与配对请求并发时也只建一次）。 */
  async #ensureSpace(): Promise<void> {
    if (this.#config.spaceId && this.#vault.secret) return;
    this.#spaceCreation ??= this.#createSpace().finally(() => {
      this.#spaceCreation = null;
    });
    await this.#spaceCreation;
  }

  /** 新空间：先落密钥再改配置；游标、已发布摘要一并作废（新会话的修订号缓存也从零开始）。 */
  async #createSpace(): Promise<void> {
    const space = generateSpace();
    await this.#vault.setSpace(space.spaceId, space.secret);
    this.#config = {
      ...this.#config,
      spaceId: space.spaceId,
      cursor: null,
      published: {},
      headDigest: null,
      lastAckSweepAt: null,
    };
    this.#devices = [];
    this.#persist();
  }

  #client(relayUrl: string, appId: string, token: string): RelayClient {
    const fetchImpl = this.#options.fetchImpl;
    return new RelayClient({
      baseUrl: relayUrl,
      appId,
      token,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  }

  #idlePhase(): Phase {
    if (!this.#config.enabled) return "disabled";
    if (!this.#configured()) return "unconfigured";
    return "connecting";
  }

  // ─── 内部：同步循环 ───

  #readySession(): SyncSession | null {
    const loop = this.#loop;
    return loop?.ready ? loop.session : null;
  }

  #launch(): void {
    if (!this.#started || this.#loop) return;
    this.#phase = this.#idlePhase();
    if (this.#phase !== "connecting") return;
    const loop: Loop = {
      controller: new AbortController(),
      promise: Promise.resolve(),
      session: null,
      ready: false,
      cursorRescued: false,
    };
    this.#loop = loop;
    loop.promise = this.#run(loop).catch((error: unknown) => this.#fail(loop, error));
  }

  async #halt(offline: boolean): Promise<void> {
    const loop = this.#loop;
    if (!loop) return;
    this.#loop = null;
    loop.controller.abort();
    await loop.promise;
    await withTimeout(this.#chain, this.#timings.stopTimeoutMs);
    if (!offline || !loop.session || !loop.ready) return;
    try {
      await withTimeout(loop.session.writePresence("offline"), this.#timings.stopTimeoutMs);
    } catch (error) {
      this.#logger.warn("写离线状态失败", { error: describeError(error) });
    }
  }

  #sessionHost(loop: Loop): SessionHost {
    return {
      service: this.#service,
      dispatch: this.#dispatch,
      appVersion: this.#options.appVersion,
      logger: this.#logger,
      now: () => this.#now(),
      config: () => this.#config,
      commit: (_session, mutate) => {
        // 已被替换（停止、换空间）的会话迟到的写入不再落到配置里。
        if (this.#loop !== loop) return;
        this.#config = mutate(this.#config);
        this.#persist();
      },
      onDevices: (devices) => {
        if (this.#loop === loop) this.#devices = devices;
      },
      onPending: (count) => {
        if (this.#loop === loop) this.#pending = count;
      },
    };
  }

  async #open(loop: Loop): Promise<SyncSession | null> {
    const { relayUrl, appId, spaceId } = this.#config;
    const { token, secret } = this.#vault;
    if (!relayUrl || !spaceId || !token || !secret) return null;
    const session = await SyncSession.open(this.#sessionHost(loop), {
      relayUrl,
      appId,
      token,
      spaceId,
      secret,
      pollIntervalMs: this.#timings.pollIntervalMs,
      ...(this.#options.fetchImpl ? { fetchImpl: this.#options.fetchImpl } : {}),
      ...(this.#options.sleep ? { sleep: this.#options.sleep } : {}),
    });
    this.#longPoll = session.probe.longPoll;
    return session;
  }

  async #run(loop: Loop): Promise<void> {
    const { signal } = loop.controller;
    let failures = 0;
    while (!signal.aborted) {
      try {
        if (!loop.session) {
          try {
            await this.#ensureSpace();
          } catch (error) {
            // 建不了配对空间（例如系统加密不可用）：重试没用，停下并说明原因。
            return this.#fail(loop, error);
          }
          loop.session = await this.#open(loop);
        }
        const session = loop.session;
        if (!session || signal.aborted) return;
        if (!loop.ready) {
          this.#publisher.beginFullPublish();
          // 第一次连这个中继：先翻到变更流头部拿游标，全量交给首次同步，不再重写第二遍。
          if (session.feed.cursor === null) await session.feed.next(signal);
          await this.#exclusive(() => session.initialSync());
          loop.ready = true;
          this.#armPresence(loop);
          this.#markSynced(loop, session);
          this.#publisher.afterFullPublish();
        }
        // 之前有游标却被要求重来 = 游标过期（410），可能漏了变更：全量重写。
        // 之前就没有游标（中继原本是空的）只是第一次拿到游标，摘要照常去重。
        const hadCursor = session.feed.cursor !== null;
        let batch: FeedBatch;
        try {
          batch = await session.feed.next(signal);
        } catch (error) {
          if (!hadCursor || loop.cursorRescued || !isCursorRejected(error)) throw error;
          // 中继不认保存的游标（换过中继类型时会回 400）：清掉从头来一次，再失败才报错。
          loop.cursorRescued = true;
          session.resetFeed();
          this.#config = { ...this.#config, cursor: null };
          this.#persist();
          this.#logger.warn("中继不认保存的变更游标，已清空并全量重同步");
          continue;
        }
        if (signal.aborted) return;
        if (!batch.reset) loop.cursorRescued = false;
        await this.#exclusive(async () => {
          if (batch.reset) await session.fullResync({ force: hadCursor });
          if (batch.changes.length > 0) await session.applyChanges(batch.changes);
          else if (session.pendingCount > 0) await session.processPending();
        });
        this.#markSynced(loop, session);
        failures = 0;
      } catch (error) {
        if (signal.aborted) return;
        if (isAuthFailure(error)) return this.#reject(loop);
        failures += 1;
        this.#phase = "retrying";
        this.#lastError = describeError(error);
        this.#logger.warn("同步失败，稍后重试", { error: this.#lastError, failures });
        // 中继限流（429）给了 retry_after 就至少等那么久。
        const asked = error instanceof RelayError ? (error.retryAfter ?? 0) * 1000 : 0;
        const delay = Math.min(60_000, Math.max(backoffDelay(failures), asked));
        await this.#sleep(delay, signal).catch(() => undefined);
      }
    }
  }

  /** 一轮成功：在线、清掉错误；游标变了才落盘（顺带记下 lastSyncAt）。 */
  #markSynced(loop: Loop, session: SyncSession): void {
    if (this.#loop !== loop) return;
    this.#phase = "online";
    this.#lastError = null;
    const cursorChanged = session.feed.cursor !== this.#config.cursor;
    this.#config = {
      ...this.#config,
      cursor: session.feed.cursor,
      lastSyncAt: this.#now().toISOString(),
    };
    if (cursorChanged) this.#persist();
  }

  /** 中继拒绝 token：停下，等用户改 token（改完会重建连接）。 */
  #reject(loop: Loop): void {
    this.#stopLoop(loop, "rejected", RELAY_REJECTED_MESSAGE);
    this.#logger.warn("中继拒绝了 token，同步已停止");
  }

  /** 重试也没用的错误（例如系统加密不可用、建不了配对空间）：停下并说明原因。 */
  #fail(loop: Loop, error: unknown): void {
    this.#stopLoop(loop, "failed", describeError(error));
    this.#logger.error("同步已停止", { error: this.#lastError });
  }

  #stopLoop(loop: Loop, phase: Phase, message: string): void {
    if (this.#loop !== loop) return;
    this.#loop = null;
    loop.controller.abort();
    this.#phase = phase;
    this.#lastError = message;
  }

  #armPresence(loop: Loop): void {
    const timer = setInterval(() => {
      const session = loop.session;
      if (this.#loop !== loop || !session) return void clearInterval(timer);
      void this.#exclusive(() => session.presenceTick()).catch((error: unknown) => {
        if (isAuthFailure(error)) this.#reject(loop);
        else this.#lastError = describeError(error);
      });
    }, this.#timings.presenceMs);
    timer.unref?.();
    loop.controller.signal.addEventListener("abort", () => clearInterval(timer), { once: true });
  }

  /** 串行执行对中继的写操作：发布、命令、在线状态不会互相穿插。 */
  #exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(task, task);
    this.#chain = run.catch(() => undefined);
    return run;
  }
}

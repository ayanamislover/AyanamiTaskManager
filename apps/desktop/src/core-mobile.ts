import { createAgentDispatcher, type AgentDispatcher } from "@ayanami-task/agent-dispatch";
import type { AyanamiTaskService } from "@ayanami-task/application";
import { DAEMON_VERSION, type DispatchController, type SyncController } from "@ayanami-task/daemon";
import {
  SyncConnector,
  dispatchPortFrom,
  syncDirectory,
  taskServiceDispatchHost,
} from "@ayanami-task/sync";
import { hostDpapi, type Dpapi } from "./dpapi.js";
import { DpapiSecretStore } from "./dpapi-secret-store.js";

/**
 * 连接器停下（含写离线状态）的总预算。原生宿主请 core 退出后只等 8 s 就强制结束
 * （native/host/src/app.rs），还要留给 HTTP 服务与数据库收尾。
 */
const SYNC_STOP_BUDGET_MS = 3000;
/** 收尾时等仍在启动的功能落定的上限（DPAPI helper 已先被中止，正常立刻落定）。 */
const STARTUP_SETTLE_MS = 1000;
/** 路由等功能起来的上限。正常几十毫秒就起来了；更久就回 503，界面会自动重试。 */
const FEATURE_WAIT_MS = 5000;

/** 手机同步与派单只写错误说明与命令 ID，不含任何密钥；core 的 console 已经改道到 stderr。 */
const mobileLogger = {
  info: () => undefined,
  warn: (message: string, meta?: Record<string, unknown>) => console.warn(`[ATM] ${message}`, meta),
  error: (message: string, meta?: Record<string, unknown>) =>
    console.error(`[ATM] ${message}`, meta),
};

/** 路由按这个形状回错误：错误码以 SYNC_ / DISPATCH_ 开头，状态码原样回给调用方。 */
class FeatureError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "FeatureError";
  }
}

type Feature = { starting(): FeatureError; unavailable(): FeatureError };

const SYNC: Feature = {
  starting: () => new FeatureError("SYNC_STARTING", 503, true, "手机同步正在启动，请稍后再试"),
  unavailable: () =>
    new FeatureError(
      "SYNC_UNAVAILABLE",
      404,
      false,
      "手机同步没能启动（原因见日志），重启 ATM 后再试",
    ),
};
const DISPATCH: Feature = {
  starting: () =>
    new FeatureError("DISPATCH_STARTING", 503, true, "Claude 派单正在启动，请稍后再试"),
  unavailable: () =>
    new FeatureError(
      "DISPATCH_UNAVAILABLE",
      404,
      false,
      "Claude 派单没能启动（原因见日志），重启 ATM 后再试",
    ),
};

/** 等 promise 至多 ms 毫秒；还没落定返回 undefined。promise 不会 reject。 */
function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    timer.unref?.();
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

/** 路由用：功能起来了就交给它；还在启动回 503，起不来回 404。 */
async function when<T>(ready: Promise<T | null>, feature: Feature, waitMs: number): Promise<T> {
  const value = await within(ready, waitMs);
  if (value === undefined) throw feature.starting();
  if (value === null) throw feature.unavailable();
  return value;
}

export type MobileFeatureOptions = {
  service: AyanamiTaskService;
  dataDir: string;
  /** 本版本目录里的原生宿主；它的 `--dpapi` 模式替 core 加解密同步密钥。 */
  hostPath: string;
  /** 测试用：换掉经宿主调 DPAPI 的实现；返回 null 表示没有 DPAPI。 */
  dpapi?: (signal: AbortSignal) => Dpapi | null;
  /** 测试用：换掉派单器的创建。 */
  createDispatcher?: typeof createAgentDispatcher;
  /** 测试用：路由等功能起来的上限。 */
  featureWaitMs?: number;
};

export type MobileFeatures = {
  /** 立即可用：功能还在后台启动时，路由先等一会儿（见 FEATURE_WAIT_MS）。 */
  sync: SyncController;
  dispatch: DispatchController;
  /** 两个功能都已起来或确定起不来。 */
  ready: Promise<void>;
  /** 有总时长上限，从不 reject；可重复调用。 */
  close(): Promise<void>;
};

/**
 * 手机同步与 Claude 派单（docs/mobile-sync.md）。两者默认关闭：未启用时连接器不联网、派单不接单。
 *
 * 它们是可选功能，所以在后台起：DPAPI 自检（要起宿主 helper）、派单恢复（要查进程身份）都不占
 * core 与宿主握手的时间，慢了或挂了也只是这两个功能晚到或不可用，ATM 本体照常就绪。
 * DPAPI 不可用时同步照样起来，状态里如实说明原因，绝不退回明文。
 */
export function startMobileFeatures(options: MobileFeatureOptions): MobileFeatures {
  const { service, dataDir } = options;
  const waitMs = options.featureWaitMs ?? FEATURE_WAIT_MS;
  const abort = new AbortController();
  const makeDpapi =
    options.dpapi ??
    ((signal: AbortSignal) =>
      process.platform === "win32" ? hostDpapi(options.hostPath, { signal }) : null);
  const unavailable = (feature: string) => (error: unknown) => {
    mobileLogger.error(`${feature}没有启动`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  };

  const secrets = DpapiSecretStore.open(syncDirectory(dataDir), makeDpapi(abort.signal));
  const createDispatcher = options.createDispatcher ?? createAgentDispatcher;
  const dispatchReady: Promise<AgentDispatcher | null> = createDispatcher({
    dataDir,
    host: taskServiceDispatchHost(service),
    logger: mobileLogger,
  }).then((dispatcher) => {
    // 起来时 core 已经在收尾：直接关掉，不留给没人管的派单器。
    if (!abort.signal.aborted) return dispatcher;
    dispatcher.close();
    return null;
  }, unavailable("Claude 派单"));

  async function startSync(): Promise<SyncConnector | null> {
    const [dispatcher, store] = await Promise.all([dispatchReady, secrets]);
    if (abort.signal.aborted) return null;
    const connector = new SyncConnector({
      dataDir,
      service,
      secrets: store,
      appVersion: DAEMON_VERSION,
      dispatch: dispatcher ? dispatchPortFrom(dispatcher) : null,
      logger: mobileLogger,
      timings: { stopTimeoutMs: SYNC_STOP_BUDGET_MS },
    });
    try {
      await connector.start();
    } catch (error) {
      // 起到一半（例如已订阅事件）也要停干净。
      await connector.stop().catch(() => undefined);
      throw error;
    }
    if (!abort.signal.aborted) return connector;
    await connector.stop();
    return null;
  }
  const syncReady = startSync().catch(unavailable("手机同步"));

  let closing: Promise<void> | null = null;
  async function shutDown(): Promise<void> {
    // 先中止在途的 DPAPI helper：还在启动的功能会立刻落定为不可用或已停。
    abort.abort();
    // 两边一起等，最坏 STARTUP_SETTLE_MS + SYNC_STOP_BUDGET_MS（再加连接器掐断后的短暂收尾）。
    const [connector, dispatcher] = await Promise.all([
      within(syncReady, STARTUP_SETTLE_MS),
      within(dispatchReady, STARTUP_SETTLE_MS),
    ]);
    try {
      // 连接器停下时要写离线状态，得在关库之前；它还会调派单，所以先停它。
      await connector?.stop();
    } catch (error) {
      mobileLogger.warn("手机同步收尾出错", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    dispatcher?.close();
  }

  return {
    sync: {
      status: async () => (await when(syncReady, SYNC, waitMs)).status(),
      updateConfig: async (patch) => (await when(syncReady, SYNC, waitMs)).updateConfig(patch),
      testRelay: async (candidate) => (await when(syncReady, SYNC, waitMs)).testRelay(candidate),
      createPairing: async () => (await when(syncReady, SYNC, waitMs)).createPairing(),
      resetSpace: async () => (await when(syncReady, SYNC, waitMs)).resetSpace(),
    },
    dispatch: {
      status: async () => (await when(dispatchReady, DISPATCH, waitMs)).status(),
      updateConfig: async (patch) =>
        (await when(dispatchReady, DISPATCH, waitMs)).updateConfig(patch),
      enqueue: async (input) => (await when(dispatchReady, DISPATCH, waitMs)).enqueue(input),
      cancel: async (run) => (await when(dispatchReady, DISPATCH, waitMs)).cancel(run),
    },
    ready: Promise.all([syncReady, dispatchReady]).then(() => undefined),
    close() {
      closing ??= shutDown();
      return closing;
    },
  };
}

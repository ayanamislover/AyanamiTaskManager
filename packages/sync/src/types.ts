import type { AyanamiTaskService } from "@ayanami-task/application";
import type { FetchLike } from "@ayanami-task/sync-protocol";
import type { DispatchPort } from "./dispatch-port.js";
import type { SecretStore } from "./secret-store.js";
import type { DeviceView, SyncLogger } from "./session.js";

/**
 * 对外状态（与桌面端 packages/client 的 SyncConnectionState 一致）：
 * - disabled：未启用或宿主已停止，不联网
 * - connecting：正在连接 / 首次同步
 * - online：正常
 * - error：出错，原因在 lastError（缺配置、中继拒绝 token、网络失败退避中等）
 */
export type SyncState = "disabled" | "connecting" | "online" | "error";

/**
 * `GET /api/v1/sync/status` 的内容（docs/mobile-sync.md §7）。
 * **不含任何密钥**：token、空间 secret、配对码都不在这里，连「token 是否已保存」也只体现在 configured 里。
 */
export type SyncStatus = {
  enabled: boolean;
  /** 中继地址、应用 ID、token 三者齐备。 */
  configured: boolean;
  relayUrl: string | null;
  appId: string;
  deviceName: string;
  state: SyncState;
  /** 中文；正常时为 null。 */
  lastError: string | null;
  lastSyncAt: string | null;
  /** 中继是否支持长轮询；还没连上过为 null。 */
  longPoll: boolean | null;
  /** 桌面端经原生宿主用 Windows DPAPI 加密，或独立 daemon 的明文文件。 */
  secretStore: "os-encrypted" | "plaintext";
  /** 其它设备（不含本机），按最后在线时间倒序。 */
  paired: DeviceView[];
  pendingCommands: number;
};

export type RelayTestResult = {
  ok: boolean;
  latencyMs: number;
  longPoll: boolean;
  server?: string;
  error?: string;
};

export type PairingResult = { pairingCode: string; spaceId: string };
export type ResetSpaceResult = { spaceId: string; removed: number; cleanupError?: string };

export type SyncTimings = {
  /** 任务变化后等多久再发布（去抖），默认 1.5 s。 */
  debounceMs: number;
  /** 持续变化时最多攒多久，默认 10 s。 */
  maxDelayMs: number;
  /** 在线状态间隔，默认 5 分钟。 */
  presenceMs: number;
  /** 不支持长轮询时的轮询间隔，默认 4 s。 */
  pollIntervalMs: number;
  /** 发布失败后多久重试，默认 15 s。 */
  retryPublishMs: number;
  /** 停止的总预算（等在途的中继写操作、写离线状态），默认 5 s；到点掐断会话的全部中继请求。 */
  stopTimeoutMs: number;
};

export const DEFAULT_TIMINGS: Readonly<SyncTimings> = Object.freeze({
  debounceMs: 1500,
  maxDelayMs: 10_000,
  presenceMs: 5 * 60 * 1000,
  pollIntervalMs: 4000,
  retryPublishMs: 15_000,
  stopTimeoutMs: 5000,
});

export type SyncConnectorOptions = {
  dataDir: string;
  service: AyanamiTaskService;
  secrets: SecretStore;
  /** 写进 head 与在线状态的 ATM 版本。 */
  appVersion: string;
  dispatch?: DispatchPort | null;
  fetchImpl?: FetchLike;
  logger?: SyncLogger;
  now?: () => Date;
  /** 默认设备名，缺省取主机名。 */
  deviceName?: string;
  timings?: Partial<SyncTimings>;
  /** 退避与轮询用的可中断睡眠，测试注入。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

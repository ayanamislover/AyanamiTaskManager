import type { ClientRequest } from "../http.js";

/**
 * 手机同步（docs/mobile-sync.md §7 REST 表）。状态接口两种令牌都能读，但**不含任何密钥**；
 * 其余写接口都是 USER_ONLY。配对码只从 `createSyncPairing` 的响应里拿，调用方不要缓存、不要落日志。
 */

/** 连接器当前状态：未启用 / 连接中 / 正常 / 出错（原因在 lastError）。 */
export type SyncConnectionState = "disabled" | "connecting" | "online" | "error";

/** 敏感项怎么落盘：桌面端走 Electron safeStorage；独立 daemon（开发 / e2e）是明文文件。 */
export type SyncSecretStore = "safeStorage" | "plaintext";

/** 已配对设备：设备自己写在中继上的在线状态文档（`<S>/dev/<deviceId>`）去掉版本号。 */
export type SyncDeviceView = {
  id: string;
  name: string;
  kind: "windows" | "android" | "other";
  role: "host" | "client";
  app: string;
  /** 设备最后一次写在线状态的时间。 */
  at: string;
  state: "online" | "offline";
};

export type SyncStatus = {
  enabled: boolean;
  /** 中继地址与 token 都已保存。token 本身永远不回传。 */
  configured: boolean;
  relayUrl: string | null;
  appId: string;
  deviceName: string;
  state: SyncConnectionState;
  lastError: string | null;
  lastSyncAt: string | null;
  /** 中继是否支持长轮询；还没连上过时为 null。 */
  longPoll: boolean | null;
  secretStore: SyncSecretStore;
  paired: SyncDeviceView[];
  pendingCommands: number;
};

/** `token` 只写不读；传空字符串表示清除。 */
export type SyncConfigPatch = {
  enabled?: boolean;
  relayUrl?: string;
  appId?: string;
  token?: string;
  deviceName?: string;
};

/** 测试连接时临时用的配置；缺的项用已保存的值。 */
export type SyncRelayCandidate = {
  relayUrl?: string;
  appId?: string;
  token?: string;
};

export type SyncRelayTestResult = {
  ok: boolean;
  latencyMs: number | null;
  longPoll: boolean;
  /** 中继自报的身份，例如 atm-relay 返回 `{ name: "atm-relay", version }`。 */
  server?: string | { name: string; version?: string };
  error?: string | { code: string; message: string };
};

export type SyncPairing = { pairingCode: string; spaceId: string };
export type SyncResetResult = { spaceId: string };

export function createSyncSurface(request: ClientRequest) {
  return {
    getSyncStatus: () => request<SyncStatus>("GET", "/api/v1/sync/status"),
    updateSyncConfig: (patch: SyncConfigPatch) =>
      request<SyncStatus>("PUT", "/api/v1/sync/config", patch),
    testSyncRelay: (candidate: SyncRelayCandidate = {}) =>
      request<SyncRelayTestResult>("POST", "/api/v1/sync/test", candidate),
    createSyncPairing: () => request<SyncPairing>("POST", "/api/v1/sync/pairing", {}),
    resetSyncSpace: () => request<SyncResetResult>("POST", "/api/v1/sync/reset", {}),
  };
}

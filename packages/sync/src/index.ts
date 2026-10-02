/**
 * 电脑侧手机同步连接器（docs/mobile-sync.md §7、ADR-017）：配置与密钥、快照发布、
 * 命令处理、在线状态。只做出站 HTTPS，默认关闭。
 */
export { SyncConnector } from "./connector.js";
export {
  DEFAULT_TIMINGS,
  type PairingResult,
  type RelayTestResult,
  type ResetSpaceResult,
  type SyncConnectorOptions,
  type SyncState,
  type SyncStatus,
  type SyncTimings,
} from "./types.js";
export {
  DEFAULT_APP_ID,
  PROCESSED_COMMAND_LIMIT,
  SyncConfigSchema,
  defaultSyncConfig,
  loadSyncConfig,
  saveSyncConfig,
  syncConfigPath,
  syncDirectory,
  type SyncConfig,
} from "./config.js";
export {
  COMMAND_CLOCK_TOLERANCE_MS,
  COMMAND_FUTURE_TOLERANCE_MS,
  executeCommand,
  validateCommand,
  type AckResult,
  type CommandContext,
} from "./commands.js";
export {
  dispatchPortFrom,
  taskServiceDispatchHost,
  type DispatchPort,
  type DispatcherLike,
  type SyncDispatchRun,
  type SyncDispatchState,
  type SyncPermissionMode,
} from "./dispatch-port.js";
export {
  RELAY_REJECTED_MESSAGE,
  SyncCommandError,
  describeError,
  type SyncCommandErrorCode,
} from "./errors.js";
export {
  FileSecretStore,
  SECRET_NAMES,
  type SecretName,
  type SecretStore,
} from "./secret-store.js";
export type { DeviceView, SyncLogger } from "./session.js";
export {
  CLOSED_LIMIT,
  CLOSED_WINDOW_MS,
  buildProjectSnapshot,
  canonicalJson,
  contentDigest,
} from "./snapshot.js";

/**
 * Claude Code 无头派单（docs/mobile-sync.md §8、ADR-016）。
 * 只处理用户点名的任务；默认关闭；宿主通过 {@link DispatchHost} 端口提供项目与任务。
 */
export { AgentDispatcher, createAgentDispatcher } from "./dispatcher.js";
export {
  DEFAULT_DISPATCH_CONFIG,
  DISPATCH_EFFORTS,
  DISPATCH_MODEL_PATTERN,
  DISPATCH_PERMISSION_MODES,
  DispatchConfigPatchSchema,
  DispatchConfigSchema,
  type DispatchConfig,
  type DispatchConfigPatch,
} from "./config.js";
export {
  DISPATCH_ERROR_POLICIES,
  DispatchError,
  isDispatchError,
  type DispatchErrorCode,
  type DispatchErrorDto,
} from "./errors.js";
export { dispatchPaths } from "./files.js";
export {
  claudeArguments,
  DISPATCH_RUN_PATTERN,
  DISPATCH_TASK_KEY_PATTERN,
  dispatchChildEnv,
  HOST_SESSION_ENV,
  launchCommand,
} from "./launch.js";
export { renderDispatchPrompt, type DispatchPromptInput } from "./prompt.js";
export { findResultLine, judgeOutcome } from "./result.js";
export { DISPATCH_HISTORY_LIMIT } from "./run-store.js";
export type {
  AgentDispatcherOptions,
  DispatchChangeEvent,
  DispatchClaudeStatus,
  DispatchHost,
  DispatchLogger,
  DispatchOrigin,
  DispatchProject,
  DispatchRunSummary,
  DispatchRunView,
  DispatchSpawn,
  DispatchState,
  DispatchStatus,
  DispatchTask,
  EnqueueInput,
} from "./types.js";

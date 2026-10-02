import type { SyncState } from "./types.js";

/**
 * 内部阶段，比对外的 state 细：对外 unconfigured / retrying / rejected / failed 都是 error，
 * stopped 是 disabled，原因写在 lastError。
 */
export type Phase =
  | "disabled"
  | "unconfigured"
  | "connecting"
  | "online"
  | "retrying"
  | "rejected"
  | "failed"
  | "stopped";

export const PUBLIC_STATE: Record<Phase, SyncState> = {
  disabled: "disabled",
  stopped: "disabled",
  connecting: "connecting",
  online: "online",
  unconfigured: "error",
  retrying: "error",
  rejected: "error",
  failed: "error",
};

export const UNCONFIGURED_MESSAGE = "已启用手机同步，但还没有填写中继地址或 token";

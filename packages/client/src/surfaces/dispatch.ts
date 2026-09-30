import type { ClientRequest } from "../http.js";

/**
 * Claude 自动派单（docs/mobile-sync.md §7、§8）。默认关闭；开启后只处理用户点名的任务。
 * 类型与 packages/agent-dispatch 的对外视图一致，这里单独声明，免得界面包依赖 Node 侧实现。
 */

export type DispatchPermissionMode = "auto" | "acceptEdits" | "bypassPermissions" | "plan";
export type DispatchEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type DispatchOrigin = "mobile" | "desktop";
export type DispatchState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type DispatchConfigView = {
  enabled: boolean;
  permissionMode: DispatchPermissionMode;
  maxConcurrent: number;
  /** null = 跟随 Claude Code 默认。 */
  model: string | null;
  effort: DispatchEffort | null;
};

/** model / effort 传 null 表示清空、改回跟随 Claude Code 默认。 */
export type DispatchConfigPatch = Partial<DispatchConfigView>;

export type DispatchRunSummary = {
  numTurns: number | null;
  durationMs: number | null;
  totalCostUsd: number | null;
  /** 会话最后的 result 文本，服务端已截到 500 字。 */
  result: string;
};

export type DispatchRunView = {
  run: string;
  project: string;
  key: string;
  title: string;
  origin: DispatchOrigin;
  state: DispatchState;
  /** 固定并持久化的 Claude 会话 ID：事后可以 `claude -r <sessionId>` 接着对话。 */
  sessionId: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number | null;
  summary?: DispatchRunSummary;
  error?: string;
};

export type DispatchClaudeStatus = { found: boolean; path: string | null; version?: string };

export type DispatchStatus = DispatchConfigView & {
  claude: DispatchClaudeStatus;
  runs: DispatchRunView[];
};

export function createDispatchSurface(request: ClientRequest) {
  return {
    getDispatchStatus: () => request<DispatchStatus>("GET", "/api/v1/dispatch/status"),
    updateDispatchConfig: (patch: DispatchConfigPatch) =>
      request<DispatchStatus>("PUT", "/api/v1/dispatch/config", patch),
    /** 桌面端「交给 Claude」：任务必须是 READY / BACKLOG 且没有有效领取。 */
    dispatchTask: (projectCode: string, taskKey: string) =>
      request<DispatchRunView>(
        "POST",
        `/api/v1/projects/${encodeURIComponent(projectCode)}/ui/work-items/${encodeURIComponent(taskKey)}/dispatch`,
        {},
      ),
    cancelDispatchRun: (run: string) =>
      request<DispatchRunView>(
        "POST",
        `/api/v1/dispatch/runs/${encodeURIComponent(run)}/cancel`,
        {},
      ),
  };
}

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

export type DispatchClaudeStatus = {
  found: boolean;
  path: string | null;
  version?: string;
  /**
   * claude 命令行是否已登录：false = 未登录或登录已过期（派单会失败，报 DISPATCH_CLAUDE_NOT_LOGGED_IN）；
   * null = 查不出来（没找到可执行文件、探测超时等），界面不下结论。
   */
  loggedIn: boolean | null;
  /** 登录方式，例如 claude.ai 订阅或 API key；只用于显示。 */
  authMethod?: string;
};

/**
 * 派单请求账本（防止同一条手机命令执行两次）的健康状况，不含任何密钥。
 * 旧版宿主没有这个字段。
 */
export type DispatchLedgerStatus = {
  /** 账本丢过数据：这个时刻（含）之前发出、电脑上又查不到记录的手机派单一律被拒；没丢过为 null。 */
  lostBefore: string | null;
  /** 上面的限制自动解除的时刻。 */
  lostUntil: string | null;
  /** 账本文件暂时读不出来：手机派单全部被拒，读得出来后自动恢复。 */
  unavailable: boolean;
};

export type DispatchStatus = DispatchConfigView & {
  claude: DispatchClaudeStatus;
  runs: DispatchRunView[];
  requestLedger?: DispatchLedgerStatus;
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
    /**
     * 结束一次派单：服务端核验进程身份、确认进程树已结束后才回 `cancelled`。
     * 没结束掉时抛 AyanamiClientError（500 DISPATCH_CANCEL_FAILED，retryable，带中文原因），
     * 派单仍在运行、名额不释放，可以重试；进行中的取消再点一次拿到同一个结果。
     */
    cancelDispatchRun: (run: string) =>
      request<DispatchRunView>(
        "POST",
        `/api/v1/dispatch/runs/${encodeURIComponent(run)}/cancel`,
        {},
      ),
  };
}

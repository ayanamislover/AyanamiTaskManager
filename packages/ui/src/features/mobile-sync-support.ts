import type {
  DispatchClaudeStatus,
  DispatchEffort,
  DispatchOrigin,
  DispatchPermissionMode,
  DispatchRunView,
  DispatchState,
  SyncDeviceView,
  SyncRelayTestResult,
  SyncStatus,
} from "@ayanami-task/client";
import type { DesktopBridge } from "../contracts.js";
import { compactPath, formatTime } from "../presentation.js";
import { ATM_QUERY_REFRESH_INTERVAL_MS } from "../query-policy.js";

/**
 * 「手机同步」「Claude 自动开工」两个设置面板和任务抽屉按钮共用的纯逻辑：
 * 状态灯、文案、表单校验、派单资格。不碰 DOM，便于单测。
 */

/** 同步状态每 5 秒刷新一次：只在设置页挂着面板时轮询。 */
export const SYNC_STATUS_REFRESH_MS = 5_000;
/** 有排队或运行中的派单时，状态 5 秒刷新一次；否则沿用全局 30 秒。 */
export const DISPATCH_ACTIVE_REFRESH_MS = 5_000;
/** 配对码在屏幕上最多停留 2 分钟。 */
export const PAIRING_VISIBLE_MS = 120_000;
/** 与手机端一致：设备的在线状态文档 7 分钟内写过才算在线（§5）。 */
export const DEVICE_ONLINE_WINDOW_MS = 7 * 60 * 1000;

export const SYNC_STATUS_QUERY_KEY = ["sync-status"] as const;
export const DISPATCH_STATUS_QUERY_KEY = ["dispatch-status"] as const;

/**
 * 宿主没有这项功能（独立 daemon 没注入派单控制器、或 daemon 是旧版本）时接口回 404：
 * 这不是「读失败」，面板说明一句就行，也不必再轮询。
 */
export function featureUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { status?: unknown }).status === 404
  );
}

export type SyncLampState = "ok" | "connecting" | "error" | "off";

/** 状态灯沿用侧栏「本地服务」那一盏：正常 / 连接中 / 出错，未启用时是灰灯。 */
export function syncLamp(status: Pick<SyncStatus, "enabled" | "state" | "lastError">): {
  state: SyncLampState;
  label: string;
  reason: string | null;
} {
  if (!status.enabled || status.state === "disabled") {
    return { state: "off", label: "未启用", reason: null };
  }
  if (status.state === "error") {
    return { state: "error", label: "出错", reason: problemText(status.lastError) ?? "原因未知" };
  }
  if (status.state === "online") return { state: "ok", label: "正常", reason: null };
  return { state: "connecting", label: "连接中", reason: null };
}

/** 服务端的错误可能是一句话，也可能是 `{code, message}`；统一取出能给人看的那句。 */
export function problemText(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && "message" in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return String(value);
}

export function formatLatency(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "未知";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function pollingLabel(longPoll: boolean | null): string {
  if (longPoll === null) return "尚未连上";
  return longPoll ? "长轮询（有变更立即收到）" : "定时轮询（每 4 秒）";
}

export function serverLabel(server: SyncRelayTestResult["server"]): string | null {
  if (!server) return null;
  if (typeof server === "string") return server;
  return server.version ? `${server.name} ${server.version}` : server.name;
}

/** 「测试连接」结果的一行说明。 */
export function describeRelayTest(result: SyncRelayTestResult): string {
  if (!result.ok) return `连接失败：${problemText(result.error) ?? "中继没有响应"}`;
  const server = serverLabel(result.server);
  return [
    "连接正常",
    `延迟 ${formatLatency(result.latencyMs)}`,
    result.longPoll ? "支持长轮询" : "不支持长轮询，将每 4 秒轮询一次",
    ...(server ? [server] : []),
  ].join(" · ");
}

export function relativeTime(value: string | null | undefined, now = Date.now()): string {
  if (!value) return "从未";
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return value;
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 0) return formatTime(value);
  if (seconds < 45) return "刚刚";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return formatTime(value);
}

const deviceKinds: Record<SyncDeviceView["kind"], string> = {
  android: "Android 手机",
  windows: "Windows 电脑",
  other: "其他设备",
};

export function deviceKindLabel(kind: string): string {
  return deviceKinds[kind as SyncDeviceView["kind"]] ?? "其他设备";
}

export function deviceOnline(device: Pick<SyncDeviceView, "at" | "state">, now = Date.now()) {
  const at = Date.parse(device.at);
  return device.state === "online" && Number.isFinite(at) && now - at <= DEVICE_ONLINE_WINDOW_MS;
}

export type SyncDraft = { relayUrl: string; appId: string; token: string; deviceName: string };

/** 与中继、手机端的约束一致：http 只允许本机回环地址，其余必须 https。 */
export function relayUrlProblem(value: string): string | null {
  const text = value.trim();
  if (!text) return "请填写中继地址";
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "中继地址不是有效的网址";
  }
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    return null;
  }
  return "中继地址必须是 https://（本机调试可用 http://127.0.0.1）";
}

const APP_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

/**
 * 表单能不能提交；`tokenSaved` 为真时 token 可以留空（沿用已保存的）。
 * 「测试连接」只探测中继，不要求本机名称（`forTest`）。
 */
export function syncDraftProblem(
  draft: SyncDraft,
  tokenSaved: boolean,
  forTest = false,
): string | null {
  const relay = relayUrlProblem(draft.relayUrl);
  if (relay) return relay;
  if (!APP_ID_PATTERN.test(draft.appId.trim())) {
    return "应用 ID 只能用小写字母、数字、- 和 _";
  }
  if (!tokenSaved && !draft.token.trim()) return "请填写中继 token";
  if (forTest) return null;
  const name = draft.deviceName.trim();
  if (!name) return "请填写本机名称";
  if (Array.from(name).length > 64) return "本机名称最多 64 个字";
  return null;
}

/** 只把用户动过的项发出去：token 留空表示沿用已保存的，不能发空串（空串是「清除」）。 */
export function syncConfigPatch(draft: SyncDraft, enabled?: boolean) {
  return {
    relayUrl: draft.relayUrl.trim(),
    appId: draft.appId.trim(),
    deviceName: draft.deviceName.trim(),
    ...(draft.token.trim() ? { token: draft.token.trim() } : {}),
    ...(enabled === undefined ? {} : { enabled }),
  };
}

export const dispatchStateLabels: Record<DispatchState, string> = {
  queued: "排队中",
  running: "进行中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

export function dispatchStateTone(state: DispatchState): string {
  if (state === "running" || state === "queued") return "primary";
  if (state === "succeeded") return "success";
  if (state === "failed") return "danger";
  return "";
}

export const dispatchOriginLabels: Record<DispatchOrigin, string> = {
  mobile: "手机",
  desktop: "桌面",
};

export function isActiveRun(run: Pick<DispatchRunView, "state">): boolean {
  return run.state === "queued" || run.state === "running";
}

/** 有排队或运行中的派单时 5 秒刷一次状态；其余时间沿用全局节奏。 */
export function dispatchRefetchInterval(data: { runs: readonly DispatchRunView[] } | undefined) {
  return data?.runs.some(isActiveRun) ? DISPATCH_ACTIVE_REFRESH_MS : ATM_QUERY_REFRESH_INTERVAL_MS;
}

/** Claude Code 登录已过期时让用户在终端里跑的命令。 */
export const CLAUDE_LOGIN_COMMAND = "claude auth login";

/**
 * 设置页「Claude Code」一行：右侧徽标、下面一行小字，以及要不要给出去登录的提示条。
 * `loggedIn` 为 null（或旧版 daemon 没有这个字段）时不下结论，照常显示「已找到」。
 */
export function claudeReadiness(
  claude: Pick<DispatchClaudeStatus, "found" | "path" | "version" | "authMethod"> & {
    loggedIn?: boolean | null;
  },
): { tone: "success" | "warning"; label: string; detail: string; needsLogin: boolean } {
  if (!claude.found) {
    return {
      tone: "warning",
      label: "未找到",
      detail: "没有找到 claude 命令行；安装 Claude Code 后重启 ATM 才能派单",
      needsLogin: false,
    };
  }
  const path = compactPath(claude.path);
  if (claude.loggedIn === false) {
    return {
      tone: "warning",
      label: "未登录",
      detail: claude.version ? `${path} · ${claude.version}` : path,
      needsLogin: true,
    };
  }
  return {
    tone: "success",
    label: `已找到${claude.version ? ` · ${claude.version}` : ""}`,
    detail:
      claude.loggedIn === true && claude.authMethod
        ? `${path} · 已登录（${claude.authMethod}）`
        : path,
    needsLogin: false,
  };
}

/** 失败的派单给一句原因（服务端的 error 字段）；其它状态没有。 */
export function dispatchFailureReason(
  run: Pick<DispatchRunView, "state" | "error">,
): string | null {
  if (run.state !== "failed") return null;
  const reason = run.error?.trim();
  return reason ? reason : null;
}

/** 桌面端走宿主的剪贴板接口，浏览器预览退回 navigator.clipboard。 */
export async function copyToClipboard(desktop: DesktopBridge | undefined, text: string) {
  if (desktop?.copyText) await desktop.copyText(text);
  else await navigator.clipboard.writeText(text);
}

export const PERMISSION_MODES: ReadonlyArray<{
  value: DispatchPermissionMode;
  label: string;
  description: string;
  risky: boolean;
}> = [
  {
    value: "auto",
    label: "自动（推荐）",
    description: "由 Claude Code 判断哪些操作可以直接做，拿不准的会停下。",
    risky: false,
  },
  {
    value: "acceptEdits",
    label: "自动接受编辑",
    description: "改文件不再确认；运行命令仍按 Claude Code 的权限规则。",
    risky: false,
  },
  {
    value: "bypassPermissions",
    label: "跳过全部确认",
    description: "有风险：会话可以不经确认执行任何命令、改任何文件。只在你信任的仓库里用。",
    risky: true,
  },
  {
    value: "plan",
    label: "只做计划",
    description: "只读代码、完善任务目标和计划，不改文件。",
    risky: false,
  },
];

export const EFFORT_OPTIONS: ReadonlyArray<{ value: DispatchEffort | ""; label: string }> = [
  { value: "", label: "跟随默认" },
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "xhigh", label: "xhigh" },
  { value: "max", label: "max" },
];

export const CONCURRENCY_OPTIONS = [1, 2, 3].map((value) => ({
  value: String(value),
  label: value === 1 ? "1 个（推荐）" : `${value} 个`,
}));

const MODEL_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u;

/** 模型名会进命令行：留空 = 跟随默认；只放行字母、数字和 . _ -。 */
export function modelInput(value: string): { model: string | null; problem: string | null } {
  const text = value.trim();
  if (!text) return { model: null, problem: null };
  return MODEL_PATTERN.test(text)
    ? { model: text, problem: null }
    : { model: null, problem: "模型名只能用字母、数字和 . _ -" };
}

/** 同一个任务可能派过多次，抽屉只看最近一次。 */
export function latestRunFor(
  runs: readonly DispatchRunView[],
  project: string,
  key: string,
): DispatchRunView | null {
  let latest: DispatchRunView | null = null;
  for (const run of runs) {
    if (run.project !== project || run.key !== key) continue;
    if (!latest || Date.parse(run.createdAt) > Date.parse(latest.createdAt)) latest = run;
  }
  return latest;
}

export type DispatchableTask = {
  status: string;
  claimedBySessionId?: unknown;
  claimLeaseUntil?: unknown;
};

/** §6：任务必须是 READY 或 BACKLOG，且没有有效领取（租约过期的领取不算）。 */
export function taskAcceptsDispatch(task: DispatchableTask, now = Date.now()): boolean {
  if (task.status !== "READY" && task.status !== "BACKLOG") return false;
  if (typeof task.claimedBySessionId !== "string" || !task.claimedBySessionId) return true;
  const lease = typeof task.claimLeaseUntil === "string" ? Date.parse(task.claimLeaseUntil) : NaN;
  return Number.isFinite(lease) && lease <= now;
}

/** 会话 ID 太长，列表里只露头 8 位；复制时给完整的。 */
export function shortSessionId(sessionId: string): string {
  return sessionId.length > 8 ? `${sessionId.slice(0, 8)}…` : sessionId;
}

export function resumeCommand(sessionId: string): string {
  return `claude -r ${sessionId}`;
}

export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** 派单列表里「开始 → 结束」一行。 */
export function runWindow(run: Pick<DispatchRunView, "createdAt" | "startedAt" | "endedAt">) {
  const start = run.startedAt
    ? `开始 ${formatTime(run.startedAt)}`
    : `提交 ${formatTime(run.createdAt)}`;
  return run.endedAt ? `${start} · 结束 ${formatTime(run.endedAt)}` : start;
}

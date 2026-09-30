import { CLAUDE_LOGIN_REQUIRED_MESSAGE } from "./errors.js";
import { readTail } from "./files.js";
import type { DispatchRunSummary } from "./types.js";

const RESULT_LIMIT = 500;
const ERROR_LIMIT = 300;

function truncate(value: string, limit: number): string {
  const points = Array.from(value);
  return points.length <= limit ? value : `${points.slice(0, limit - 1).join("")}…`;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 从 stream-json 日志末尾往前找最后一行 `{"type":"result",...}`；没有返回 null。 */
export function findResultLine(text: string): Record<string, unknown> | null {
  const lines = text.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (!line.startsWith("{") || !line.includes('"result"')) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (value as { type?: unknown }).type === "result"
      )
        return value as Record<string, unknown>;
    } catch {
      // 截断的首行或非 JSON 噪声，跳过。
    }
  }
  return null;
}

export type DispatchOutcome = {
  state: "succeeded" | "failed";
  summary?: DispatchRunSummary;
  error?: string;
  /** 失败原因是 claude 没登录或登录过期；调用方据此让登录状态缓存失效。 */
  authFailure?: true;
};

/**
 * 鉴权失败的特征，大小写不敏感，只对已判定失败的会话使用。
 * 「OAuth」单独出现不算：stderr 里常有「某个 MCP 服务器需要 OAuth 授权」这类与 claude 本身登录
 * 无关的提示，所以要求它后面跟着过期、吊销、无效或刷新。
 */
const AUTH_FAILURE_PATTERNS = [
  /failed to authenticate/iu,
  /not logged in/iu,
  /invalid api key/iu,
  /please run \/login/iu,
  /authentication_error/iu,
  /\boauth\b[^\n]{0,80}\b(?:expired|revoked|invalid|refresh)/iu,
];

export function isAuthFailure(text: string): boolean {
  return AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

export function summarizeResult(result: Record<string, unknown>): DispatchRunSummary {
  return {
    numTurns: numberOrNull(result.num_turns),
    durationMs: numberOrNull(result.duration_ms),
    totalCostUsd: numberOrNull(result.total_cost_usd),
    result: truncate(typeof result.result === "string" ? result.result : "", RESULT_LIMIT),
  };
}

/**
 * 按日志判定一次派单的结局。`subtype` 为 success 但 `is_error` 为真的情况真实存在
 * （实测：登录态过期时 `{"subtype":"success","is_error":true,"result":"Failed to authenticate…"}`），
 * 所以两个条件都要看。鉴权失败的 `error` 换成能照着做的中文，原文留在 `summary.result`。
 */
export function judgeOutcome(
  stdoutLog: string,
  stderrLog: string,
  exitCode: number | null,
): DispatchOutcome {
  const result = findResultLine(readTail(stdoutLog));
  const stderrTail = readTail(stderrLog, 16 * 1024);
  if (result) {
    const summary = summarizeResult(result);
    if (result.subtype === "success" && result.is_error !== true)
      return { state: "succeeded", summary };
    const text = typeof result.result === "string" ? result.result : "";
    if (isAuthFailure(text) || isAuthFailure(stderrTail))
      return { state: "failed", summary, error: CLAUDE_LOGIN_REQUIRED_MESSAGE, authFailure: true };
    const reason =
      summary.result || (typeof result.subtype === "string" ? result.subtype : "未知错误");
    return { state: "failed", summary, error: truncate(reason, ERROR_LIMIT) };
  }
  const stderr = stderrTail
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" | ");
  if (isAuthFailure(stderrTail))
    return {
      state: "failed",
      summary: {
        numTurns: null,
        durationMs: null,
        totalCostUsd: null,
        result: truncate(stderr, RESULT_LIMIT),
      },
      error: CLAUDE_LOGIN_REQUIRED_MESSAGE,
      authFailure: true,
    };
  const exit = exitCode === null ? "进程已结束" : `进程退出（exit code ${exitCode}）`;
  return {
    state: "failed",
    error: truncate(stderr ? `${exit}：${stderr}` : `${exit}，日志里没有 result 行`, ERROR_LIMIT),
  };
}

export function logHasResult(stdoutLog: string): boolean {
  return findResultLine(readTail(stdoutLog)) !== null;
}

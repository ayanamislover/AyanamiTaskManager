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
};

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
 * 所以两个条件都要看。
 */
export function judgeOutcome(
  stdoutLog: string,
  stderrLog: string,
  exitCode: number | null,
): DispatchOutcome {
  const result = findResultLine(readTail(stdoutLog));
  if (result) {
    const summary = summarizeResult(result);
    if (result.subtype === "success" && result.is_error !== true)
      return { state: "succeeded", summary };
    const reason =
      summary.result || (typeof result.subtype === "string" ? result.subtype : "未知错误");
    return { state: "failed", summary, error: truncate(reason, ERROR_LIMIT) };
  }
  const stderr = readTail(stderrLog, 16 * 1024)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" | ");
  const exit = exitCode === null ? "进程已结束" : `进程退出（exit code ${exitCode}）`;
  return {
    state: "failed",
    error: truncate(stderr ? `${exit}：${stderr}` : `${exit}，日志里没有 result 行`, ERROR_LIMIT),
  };
}

export function logHasResult(stdoutLog: string): boolean {
  return findResultLine(readTail(stdoutLog)) !== null;
}

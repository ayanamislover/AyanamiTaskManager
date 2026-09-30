import { AtmError } from "@ayanami-task/errors";
import { RelayError, SyncProtocolError } from "@ayanami-task/sync-protocol";

/**
 * 命令处理失败时写进 `ok:false` ack 的错误码。派单被拒时透传 agent-dispatch 的
 * `DISPATCH_*` 码，ATM 业务错误透传 AtmError 的码，这里只列连接器自己的判断。
 */
export type SyncCommandErrorCode =
  | "COMMAND_INVALID"
  | "COMMAND_UNREADABLE"
  | "COMMAND_EXPIRED"
  | "PROJECT_NOT_FOUND"
  | "TASK_NOT_FOUND"
  | "DISPATCH_UNAVAILABLE"
  | "COMMAND_FAILED";

/** 派单被拒时照实透传的 agent-dispatch 错误码，例如 `DISPATCH_DISABLED`。 */
export type PassthroughDispatchCode = `DISPATCH_${string}`;

export class SyncCommandError extends Error {
  readonly code: SyncCommandErrorCode | PassthroughDispatchCode;

  constructor(code: SyncCommandErrorCode | PassthroughDispatchCode, message: string) {
    super(message);
    this.name = "SyncCommandError";
    this.code = code;
  }
}

/** 中继拒绝 token 时状态里显示的话。 */
export const RELAY_REJECTED_MESSAGE =
  "中继拒绝了 token：请检查 token 是否填错、是否已被吊销，改好后重新保存";

export function isAuthFailure(error: unknown): boolean {
  return error instanceof RelayError && error.isAuthFailure;
}

function clip(text: string, max = 500): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * 把任意错误翻成给用户看的中文一句话。中继的错误体与网络层消息都不含 token，
 * 这里也不拼接请求头或 URL 查询串。
 */
export function describeError(error: unknown): string {
  if (error instanceof RelayError) {
    if (error.isAuthFailure) return `${RELAY_REJECTED_MESSAGE}（HTTP ${error.status}）`;
    if (error.status === 0) return clip(error.message);
    if (error.status === 404)
      return clip(`中继上找不到请求的内容（${error.code}）：请检查地址与应用 ID`);
    if (error.status === 429) return "中继限流，稍后会自动重试";
    if (error.status >= 500)
      return clip(`中继暂时不可用（HTTP ${error.status}）：${error.message}`);
    return clip(`中继返回 ${error.status}（${error.code}）：${error.message}`);
  }
  if (error instanceof SyncProtocolError || error instanceof SyncCommandError) {
    return clip(error.message);
  }
  if (error instanceof AtmError) return clip(error.message);
  const message = error instanceof Error ? error.message : String(error);
  return clip(`同步出错：${message}`);
}

/** 写进 ack 的 `{code, message}`，长度按协议截断。 */
export function ackError(error: unknown): { code: string; message: string } {
  if (error instanceof SyncCommandError || error instanceof AtmError) {
    return { code: error.code.slice(0, 64), message: clip(error.message) };
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/u.test(code)) {
    return { code, message: clip(error instanceof Error ? error.message : String(error)) };
  }
  return { code: "COMMAND_FAILED", message: describeError(error) };
}

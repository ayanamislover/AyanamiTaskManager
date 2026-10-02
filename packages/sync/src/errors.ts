import { AtmError } from "@ayanami-task/errors";
import { RelayError, SyncProtocolError } from "@ayanami-task/sync-protocol";
import type { SyncLogger } from "./logger.js";

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
 * 中继错误的一句话。中继不可信（它看得到 Authorization，能把 token 写进错误正文反射回来），
 * 所以这里只拼 HTTP 状态、白名单里的错误码和本地固定文案——RelayError 保证 code 与 message
 * 都不含中继返回的原文（sync-protocol relay-client.ts）。不拼请求头、URL 或查询串。
 */
function describeRelayError(error: RelayError): string {
  if (error.isAuthFailure) return `${RELAY_REJECTED_MESSAGE}（HTTP ${error.status}）`;
  if (error.status === 0) return clip(error.message);
  if (error.status === 404) return "中继上找不到请求的内容（HTTP 404）：请检查地址与应用 ID";
  if (error.status === 429) return "中继限流，稍后会自动重试";
  const code = error.code === "RELAY_ERROR" ? "" : `，${error.code}`;
  return clip(`${error.message}（HTTP ${error.status}${code}）`);
}

/** 把任意错误翻成给用户看的中文一句话。 */
export function describeError(error: unknown): string {
  if (error instanceof RelayError) return describeRelayError(error);
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

/** {@link redactSecrets} 换上的占位。 */
export const REDACTED = "[已隐藏]";
/** 太短的值不替换：会把正常文字切碎，而 token 至少 8 位、空间 secret 43 位。 */
const MIN_REDACT_LENGTH = 4;

/**
 * 纵深防御：把已知密钥（中继 token、空间 secret）的字面量及其 URL 编码形式从要外显的文字里抹掉。
 * 这只是补充——远端文本本来就进不来（见 {@link describeError}），不能拿它代替白名单。
 */
export function redactSecrets(text: string, secrets: Iterable<string | null | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < MIN_REDACT_LENGTH) continue;
    for (const form of new Set([secret, encodeURIComponent(secret)]))
      out = out.split(form).join(REDACTED);
  }
  return out;
}

/** 日志 meta 最多往下看这么多层，更深的整体换成占位（不放过没检查过的内容）。 */
const REDACT_DEPTH = 6;

/**
 * 包一层日志：消息与 meta 里的字符串（任意层）都先过 {@link redactSecrets}。meta 里的 Error 换成
 * 「名字: 消息」再过一遍（宿主日志常把 Error 连同 message 打出来）；Date 原样，其它非普通对象转成字符串。
 */
export function redactingLogger(
  logger: SyncLogger,
  secrets: () => Iterable<string | null | undefined>,
): SyncLogger {
  const scrub = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") return redactSecrets(value, secrets());
    if (value === null || typeof value !== "object" || value instanceof Date) return value;
    if (value instanceof Error) return scrub(`${value.name}: ${value.message}`, depth);
    if (depth <= 0) return "[…]";
    if (Array.isArray(value)) return value.map((item) => scrub(item, depth - 1));
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return scrub(String(value), depth);
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, scrub(item, depth - 1)]),
    );
  };
  const wrap =
    (level: keyof SyncLogger) =>
    (message: string, meta?: Record<string, unknown>): void => {
      const text = redactSecrets(message, secrets());
      if (meta === undefined) logger[level](text);
      else logger[level](text, scrub(meta, REDACT_DEPTH) as Record<string, unknown>);
    };
  return { info: wrap("info"), warn: wrap("warn"), error: wrap("error") };
}

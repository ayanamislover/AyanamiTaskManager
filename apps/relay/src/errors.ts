// 统一错误：写成 {"error":{"code","message","retry_after"?}}，与 AyanamiCloud 的错误体同形。
//
// `extra` 里的字段平铺到 error 的同一层（例如 409 REVISION_CONFLICT 的 `current`），
// 不塞进 error 里面——客户端按 AyanamiCloud 契约读的是顶层 `current`。

export class RelayError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter: number | undefined;
  /** 已序列化好的同层 JSON 片段：键 → JSON 文本。文档正文很大，避免反复 parse/stringify。 */
  readonly extraJson: ReadonlyArray<readonly [string, string]>;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { retryAfter?: number; extraJson?: ReadonlyArray<readonly [string, string]> } = {},
  ) {
    super(message);
    this.name = "RelayError";
    this.status = status;
    this.code = code;
    this.retryAfter = options.retryAfter;
    this.extraJson = options.extraJson ?? [];
  }

  /** 响应体文本。 */
  toJson(): string {
    const body: { code: string; message: string; retry_after?: number } = {
      code: this.code,
      message: this.message,
    };
    if (this.retryAfter !== undefined) body.retry_after = this.retryAfter;
    let out = `{"error":${JSON.stringify(body)}`;
    for (const [key, json] of this.extraJson) out += `,${JSON.stringify(key)}:${json}`;
    return `${out}}`;
  }
}

export const badRequest = (message: string) => new RelayError(400, "BAD_REQUEST", message);
export const invalidArgument = (message: string) =>
  new RelayError(400, "INVALID_ARGUMENT", message);
export const unauthorized = (message = "缺少 token 或 token 无效") =>
  new RelayError(401, "UNAUTHORIZED", message);
export const forbidden = (message: string) => new RelayError(403, "FORBIDDEN", message);
export const notFound = (message = "不存在") => new RelayError(404, "NOT_FOUND", message);
export const payloadTooLarge = (message: string) =>
  new RelayError(413, "PAYLOAD_TOO_LARGE", message);
export const insufficientStorage = (message: string) =>
  new RelayError(507, "INSUFFICIENT_STORAGE", message);
export const tooManyRequests = (code: string, message: string, retryAfter: number) =>
  new RelayError(429, code, message, { retryAfter });

export function internalError(): RelayError {
  return new RelayError(500, "INTERNAL", "服务器内部错误");
}

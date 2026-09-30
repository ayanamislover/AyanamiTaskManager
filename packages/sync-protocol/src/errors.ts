export type SyncProtocolErrorCode =
  | "PAIRING_CODE_INVALID"
  | "RELAY_URL_INVALID"
  | "KEY_INVALID"
  | "KEY_MISMATCH"
  | "DECRYPT_FAILED"
  | "OBJECT_INCOMPLETE"
  | "OBJECT_TOO_LARGE"
  | "SCHEMA_INVALID";

const MESSAGES: Record<SyncProtocolErrorCode, string> = {
  PAIRING_CODE_INVALID: "配对码无法识别，请重新扫码或完整复制电脑上的配对码",
  RELAY_URL_INVALID: "中继地址必须是 https；只有本机调试地址（127.0.0.1 / localhost）允许 http",
  KEY_INVALID: "文档键不合法",
  KEY_MISMATCH: "配对密钥已更换，请在电脑上重新获取配对码",
  DECRYPT_FAILED: "内容校验失败：可能被篡改，或不是这个配对空间写入的",
  OBJECT_INCOMPLETE: "内容正在更新，稍后再试",
  OBJECT_TOO_LARGE: "内容超过同步上限",
  SCHEMA_INVALID: "内容格式不符合同步协议",
};

/** 同步协议层的错误。`message` 是可以直接给用户看的中文。 */
export class SyncProtocolError extends Error {
  readonly code: SyncProtocolErrorCode;

  constructor(code: SyncProtocolErrorCode, detail?: string) {
    super(detail ? `${MESSAGES[code]}（${detail}）` : MESSAGES[code]);
    this.name = "SyncProtocolError";
    this.code = code;
  }
}

export function isSyncProtocolError(value: unknown): value is SyncProtocolError {
  return value instanceof SyncProtocolError;
}

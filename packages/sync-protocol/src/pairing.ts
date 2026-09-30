import { z } from "zod";

import { SPACE_SECRET_BYTES } from "./crypto.js";
import { fromBase64Url, fromUtf8, randomBytes, toBase64Url, utf8 } from "./encoding.js";
import { SyncProtocolError } from "./errors.js";
import { APP_ID_PATTERN, SPACE_ID_PATTERN, newSpaceId } from "./keys.js";

export const PAIRING_PREFIX = "atm1:";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * 中继地址只接受 https；http 只留给本机调试（`adb reverse` 后手机访问 127.0.0.1）。
 * 返回去掉末尾斜杠的规范形式。
 */
export function normalizeRelayUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new SyncProtocolError("RELAY_URL_INVALID");
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new SyncProtocolError("RELAY_URL_INVALID");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new SyncProtocolError("RELAY_URL_INVALID", "地址里不能带账号、查询串或锚点");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export const PairingPayloadSchema = z.object({
  v: z.literal(1),
  /** 中继地址 */
  u: z.string().min(1).max(512),
  /** 中继上的应用 ID */
  a: z.string().regex(APP_ID_PATTERN),
  /** 中继 token */
  t: z.string().min(8).max(512),
  /** 空间 ID */
  s: z.string().regex(SPACE_ID_PATTERN),
  /** 空间密钥（base64url，32 字节） */
  k: z.string().length(43),
  /** 电脑名 */
  n: z.string().max(64),
});
export type PairingPayload = z.infer<typeof PairingPayloadSchema>;

export function encodePairingCode(payload: PairingPayload): string {
  const checked = PairingPayloadSchema.parse({ ...payload, u: normalizeRelayUrl(payload.u) });
  return PAIRING_PREFIX + toBase64Url(utf8(JSON.stringify(checked)));
}

/** 容忍复制时带进来的空白与换行。 */
export function decodePairingCode(code: string): PairingPayload {
  const compact = code.replace(/\s+/g, "");
  if (!compact.startsWith(PAIRING_PREFIX)) {
    throw new SyncProtocolError("PAIRING_CODE_INVALID", "应以 atm1: 开头");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromUtf8(fromBase64Url(compact.slice(PAIRING_PREFIX.length))));
  } catch {
    throw new SyncProtocolError("PAIRING_CODE_INVALID", "内容不完整");
  }
  const result = PairingPayloadSchema.safeParse(parsed);
  if (!result.success) throw new SyncProtocolError("PAIRING_CODE_INVALID", "字段不全或格式不对");
  const secret = fromBase64Url(result.data.k);
  if (secret.length !== SPACE_SECRET_BYTES) {
    throw new SyncProtocolError("PAIRING_CODE_INVALID", "空间密钥长度不对");
  }
  return { ...result.data, u: normalizeRelayUrl(result.data.u) };
}

export type NewSpace = { spaceId: string; secret: string };

export function generateSpace(): NewSpace {
  return { spaceId: newSpaceId(), secret: toBase64Url(randomBytes(SPACE_SECRET_BYTES)) };
}

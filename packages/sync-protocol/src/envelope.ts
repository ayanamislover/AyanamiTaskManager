import { z } from "zod";

import { openBytes, sealBytes, sha256Hex, type SpaceKeys } from "./crypto.js";
import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from "./encoding.js";
import { SyncProtocolError } from "./errors.js";
import { partKey } from "./keys.js";

/** 每片密文 base64url 的最大长度；加上信封字段后远低于中继 256 KiB 的单文档上限。 */
export const PART_CHARS = 160_000;
export const MAX_PARTS = 64;

export const HeadEnvelopeSchema = z.object({
  v: z.literal(1),
  kid: z.string().regex(/^[0-9a-f]{8}$/),
  iv: z.string().min(16).max(16),
  z: z.union([z.literal(0), z.literal(1)]),
  n: z.number().int().min(1).max(MAX_PARTS),
  d: z.string().regex(/^[0-9a-f]{16}$/),
  c: z.string().max(PART_CHARS),
});
export type HeadEnvelope = z.infer<typeof HeadEnvelopeSchema>;

export const PartEnvelopeSchema = z.object({
  v: z.literal(1),
  d: z.string().regex(/^[0-9a-f]{16}$/),
  i: z
    .number()
    .int()
    .min(1)
    .max(MAX_PARTS - 1),
  c: z.string().max(PART_CHARS),
});
export type PartEnvelope = z.infer<typeof PartEnvelopeSchema>;

export type SealedPart = { key: string; data: HeadEnvelope | PartEnvelope };

/**
 * 把一个对象加密成 1..n 片。返回数组的第 0 项是提交点（写在逻辑键本身），
 * 写入时必须**最后**写它；其余各片写在 `<逻辑键>.<i>`。
 */
export async function sealObject(
  keys: SpaceKeys,
  logicalKey: string,
  value: unknown,
): Promise<SealedPart[]> {
  const sealed = await sealBytes(keys, logicalKey, utf8(JSON.stringify(value)));
  const text = toBase64Url(sealed.ciphertext);
  const digest = (await sha256Hex(sealed.ciphertext)).slice(0, 16);
  const count = Math.max(1, Math.ceil(text.length / PART_CHARS));
  if (count > MAX_PARTS) throw new SyncProtocolError("OBJECT_TOO_LARGE");
  const slices = Array.from({ length: count }, (_, index) =>
    text.slice(index * PART_CHARS, (index + 1) * PART_CHARS),
  );
  const head: SealedPart = {
    key: logicalKey,
    data: {
      v: 1,
      kid: keys.kid,
      iv: toBase64Url(sealed.iv),
      z: sealed.compressed ? 1 : 0,
      n: count,
      d: digest,
      c: slices[0] ?? "",
    },
  };
  const rest = slices.slice(1).map<SealedPart>((chunk, offset) => ({
    key: partKey(logicalKey, offset + 1),
    data: { v: 1, d: digest, i: offset + 1, c: chunk },
  }));
  return [head, ...rest];
}

export function parseHeadEnvelope(data: unknown): HeadEnvelope {
  const parsed = HeadEnvelopeSchema.safeParse(data);
  if (!parsed.success) throw new SyncProtocolError("SCHEMA_INVALID", "信封");
  return parsed.data;
}

export function parsePartEnvelope(data: unknown): PartEnvelope {
  const parsed = PartEnvelopeSchema.safeParse(data);
  if (!parsed.success) throw new SyncProtocolError("SCHEMA_INVALID", "分片");
  return parsed.data;
}

/**
 * 按第 0 片的声明读取其余分片并解密。任何一片的摘要与第 0 片不一致，说明写入方正在更新，
 * 抛 OBJECT_INCOMPLETE 让调用方稍后重读。
 */
export async function openObject(
  keys: SpaceKeys,
  logicalKey: string,
  head: HeadEnvelope,
  readPart: (key: string) => Promise<unknown>,
): Promise<unknown> {
  if (head.kid !== keys.kid) throw new SyncProtocolError("KEY_MISMATCH");
  const chunks = [head.c];
  for (let index = 1; index < head.n; index += 1) {
    const raw = await readPart(partKey(logicalKey, index));
    if (raw === null || raw === undefined) throw new SyncProtocolError("OBJECT_INCOMPLETE");
    const part = parsePartEnvelope(raw);
    if (part.d !== head.d || part.i !== index) throw new SyncProtocolError("OBJECT_INCOMPLETE");
    chunks.push(part.c);
  }
  let ciphertext: Uint8Array;
  let iv: Uint8Array;
  try {
    ciphertext = fromBase64Url(chunks.join(""));
    iv = fromBase64Url(head.iv);
  } catch {
    throw new SyncProtocolError("DECRYPT_FAILED", "编码");
  }
  // 各片都声称属于同一版本、拼起来却对不上摘要：这是篡改或损坏，不是写入进行中，不重试。
  if ((await sha256Hex(ciphertext)).slice(0, 16) !== head.d) {
    throw new SyncProtocolError("DECRYPT_FAILED", "摘要不符");
  }
  const plaintext = await openBytes(keys, logicalKey, { iv, ciphertext, compressed: head.z === 1 });
  try {
    return JSON.parse(fromUtf8(plaintext)) as unknown;
  } catch {
    throw new SyncProtocolError("SCHEMA_INVALID", "明文不是 JSON");
  }
}

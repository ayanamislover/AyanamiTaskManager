import { Inflate, deflateSync } from "fflate";

import { concatBytes, fromBase64Url, randomBytes, toHex, utf8 } from "./encoding.js";
import { SyncProtocolError } from "./errors.js";

/** 空间密钥长度（字节）。 */
export const SPACE_SECRET_BYTES = 32;
/** 单个对象解压后的上限，防止解压炸弹。 */
export const MAX_PLAINTEXT_BYTES = 16 * 1024 * 1024;
/** 明文超过这个长度才压缩。 */
export const COMPRESS_THRESHOLD_BYTES = 1024;

const HKDF_SALT = utf8("atm-sync/v1");
const IV_BYTES = 12;

export type SpaceKeys = {
  /** 用来识别配错密钥的 8 位 hex，不是秘密。 */
  readonly kid: string;
  readonly aead: CryptoKey;
  readonly names: CryptoKey;
};

function subtle(): SubtleCrypto {
  const value = globalThis.crypto?.subtle;
  if (!value) throw new Error("WEBCRYPTO_UNAVAILABLE");
  return value;
}

// TypeScript 的 DOM 类型要求 BufferSource 背后是 ArrayBuffer；复制一份即可满足。
function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

export function decodeSpaceSecret(secret: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(secret);
  } catch {
    throw new SyncProtocolError("PAIRING_CODE_INVALID", "空间密钥不是 base64url");
  }
  if (bytes.length !== SPACE_SECRET_BYTES) {
    throw new SyncProtocolError("PAIRING_CODE_INVALID", "空间密钥长度不对");
  }
  return bytes;
}

export async function deriveSpaceKeys(secret: string): Promise<SpaceKeys> {
  const raw = decodeSpaceSecret(secret);
  const base = await subtle().importKey("raw", buffer(raw), "HKDF", false, ["deriveKey"]);
  const hkdf = (info: string): HkdfParams => ({
    name: "HKDF",
    hash: "SHA-256",
    salt: buffer(HKDF_SALT),
    info: buffer(utf8(info)),
  });
  const aead = await subtle().deriveKey(
    hkdf("aead"),
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const names = await subtle().deriveKey(
    hkdf("names"),
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
  const kid = (await hmacHex(names, "kid")).slice(0, 8);
  return { kid, aead, names };
}

export async function hmacHex(key: CryptoKey, message: string): Promise<string> {
  const signature = await subtle().sign("HMAC", key, buffer(utf8(message)));
  return toHex(new Uint8Array(signature));
}

/** 项目码经 HMAC 后才进文档键，中继看不到项目名。 */
export async function projectHash(keys: SpaceKeys, projectCode: string): Promise<string> {
  return (await hmacHex(keys.names, `project:${projectCode}`)).slice(0, 20);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await subtle().digest("SHA-256", buffer(bytes));
  return toHex(new Uint8Array(digest));
}

export type SealedBytes = { iv: Uint8Array; ciphertext: Uint8Array; compressed: boolean };

export async function sealBytes(
  keys: SpaceKeys,
  aad: string,
  plaintext: Uint8Array,
): Promise<SealedBytes> {
  if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new SyncProtocolError("OBJECT_TOO_LARGE");
  const compressed = plaintext.length > COMPRESS_THRESHOLD_BYTES;
  const body = compressed ? deflateSync(plaintext, { level: 6 }) : plaintext;
  const iv = randomBytes(IV_BYTES);
  const ciphertext = await subtle().encrypt(
    { name: "AES-GCM", iv: buffer(iv), additionalData: buffer(utf8(aad)) },
    keys.aead,
    buffer(body),
  );
  return { iv, ciphertext: new Uint8Array(ciphertext), compressed };
}

export async function openBytes(
  keys: SpaceKeys,
  aad: string,
  sealed: SealedBytes,
): Promise<Uint8Array> {
  if (sealed.iv.length !== IV_BYTES) throw new SyncProtocolError("DECRYPT_FAILED", "iv");
  let body: Uint8Array;
  try {
    body = new Uint8Array(
      await subtle().decrypt(
        { name: "AES-GCM", iv: buffer(sealed.iv), additionalData: buffer(utf8(aad)) },
        keys.aead,
        buffer(sealed.ciphertext),
      ),
    );
  } catch {
    throw new SyncProtocolError("DECRYPT_FAILED");
  }
  return sealed.compressed ? inflateLimited(body, MAX_PLAINTEXT_BYTES) : body;
}

/** 流式解压并在超过上限时中止，不信任对方声明的大小。 */
export function inflateLimited(data: Uint8Array, limit: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let done = false;
  const inflater = new Inflate((chunk, final) => {
    total += chunk.length;
    if (total > limit) throw new SyncProtocolError("OBJECT_TOO_LARGE");
    chunks.push(chunk);
    if (final) done = true;
  });
  try {
    inflater.push(data, true);
  } catch (error) {
    if (error instanceof SyncProtocolError) throw error;
    throw new SyncProtocolError("DECRYPT_FAILED", "解压失败");
  }
  if (!done) throw new SyncProtocolError("DECRYPT_FAILED", "压缩流不完整");
  return concatBytes(chunks);
}

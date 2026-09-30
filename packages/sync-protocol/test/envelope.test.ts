import { deflateSync } from "fflate";
import { describe, expect, it } from "vitest";

import { inflateLimited } from "../src/crypto.js";
import {
  PART_CHARS,
  SyncProtocolError,
  deriveSpaceKeys,
  generateSpace,
  openObject,
  parseHeadEnvelope,
  projectHash,
  sealObject,
  type HeadEnvelope,
  type SealedPart,
} from "../src/index.js";

async function keysPair() {
  const space = generateSpace();
  return { space, keys: await deriveSpaceKeys(space.secret) };
}

function reader(parts: SealedPart[]) {
  const byKey = new Map(parts.map((part) => [part.key, part.data]));
  return async (key: string) => byKey.get(key) ?? null;
}

// 伪随机但可复现的「难压缩」文本，用来逼出多片。
function noisyText(length: number): string {
  let seed = 7;
  let out = "";
  while (out.length < length) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out += seed.toString(36);
  }
  return out.slice(0, length);
}

describe("加密信封", () => {
  it("小对象单片往返，且不压缩", async () => {
    const { keys } = await keysPair();
    const parts = await sealObject(keys, "atm1/aaaaaaaaaaaaaaaaaaaaaaaa/head", { hello: "世界" });
    expect(parts).toHaveLength(1);
    const head = parseHeadEnvelope(parts[0]?.data);
    expect(head.z).toBe(0);
    expect(head.kid).toBe(keys.kid);
    const value = await openObject(keys, parts[0]!.key, head, reader(parts));
    expect(value).toEqual({ hello: "世界" });
  });

  it("大对象压缩并分片，按片读回", async () => {
    const { keys } = await keysPair();
    const key = "atm1/aaaaaaaaaaaaaaaaaaaaaaaa/p/0123456789abcdef0123";
    const value = { blob: noisyText(PART_CHARS * 2) };
    const parts = await sealObject(keys, key, value);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.slice(1).map((part) => part.key)).toEqual(
      parts.slice(1).map((_, index) => `${key}.${index + 1}`),
    );
    const head = parseHeadEnvelope(parts[0]?.data);
    expect(head.z).toBe(1);
    expect(head.n).toBe(parts.length);
    expect(await openObject(keys, key, head, reader(parts))).toEqual(value);
  });

  it("AAD 绑定键名：把密文挪到别的键下解密失败", async () => {
    const { keys } = await keysPair();
    const parts = await sealObject(keys, "atm1/aaaaaaaaaaaaaaaaaaaaaaaa/cmd/a", { x: 1 });
    const head = parseHeadEnvelope(parts[0]?.data);
    await expect(
      openObject(keys, "atm1/aaaaaaaaaaaaaaaaaaaaaaaa/cmd/b", head, reader(parts)),
    ).rejects.toMatchObject({ code: "DECRYPT_FAILED" });
  });

  it("别的空间的密钥：kid 不符直接报 KEY_MISMATCH", async () => {
    const a = await keysPair();
    const b = await keysPair();
    const parts = await sealObject(a.keys, "atm1/aaaaaaaaaaaaaaaaaaaaaaaa/head", { x: 1 });
    const head = parseHeadEnvelope(parts[0]?.data);
    await expect(openObject(b.keys, parts[0]!.key, head, reader(parts))).rejects.toMatchObject({
      code: "KEY_MISMATCH",
    });
  });

  it("篡改密文：各片摘要一致但内容对不上，报 DECRYPT_FAILED 而不是让人重试", async () => {
    const { keys } = await keysPair();
    const parts = await sealObject(keys, "atm1/aaaaaaaaaaaaaaaaaaaaaaaa/head", { secret: "abc" });
    const head = parseHeadEnvelope(parts[0]?.data);
    const flipped = head.c.startsWith("A") ? `B${head.c.slice(1)}` : `A${head.c.slice(1)}`;
    const tampered: HeadEnvelope = { ...head, c: flipped };
    await expect(openObject(keys, parts[0]!.key, tampered, reader(parts))).rejects.toMatchObject({
      code: "DECRYPT_FAILED",
    });
  });

  it("写入进行中：某片属于别的版本时报 OBJECT_INCOMPLETE", async () => {
    const { keys } = await keysPair();
    const key = "atm1/aaaaaaaaaaaaaaaaaaaaaaaa/p/0123456789abcdef0123";
    const oldParts = await sealObject(keys, key, { blob: noisyText(PART_CHARS * 2) });
    const newParts = await sealObject(keys, key, { blob: noisyText(PART_CHARS * 2 + 10) });
    const mixed = [oldParts[0]!, ...newParts.slice(1)];
    const head = parseHeadEnvelope(mixed[0]?.data);
    await expect(openObject(keys, key, head, reader(mixed))).rejects.toMatchObject({
      code: "OBJECT_INCOMPLETE",
    });
  });

  it("项目码经 HMAC 进键名：同密钥稳定，换密钥不同，且不含原文", async () => {
    const a = await keysPair();
    const b = await keysPair();
    const first = await projectHash(a.keys, "ATM");
    expect(first).toMatch(/^[0-9a-f]{20}$/);
    expect(await projectHash(a.keys, "ATM")).toBe(first);
    expect(await projectHash(b.keys, "ATM")).not.toBe(first);
    expect(first).not.toContain("ATM".toLowerCase());
  });

  it("解压有上限：压缩炸弹在超限时中止", () => {
    const bomb = deflateSync(new Uint8Array(4 * 1024 * 1024));
    expect(() => inflateLimited(bomb, 1024 * 1024)).toThrow(SyncProtocolError);
    expect(inflateLimited(bomb, 8 * 1024 * 1024)).toHaveLength(4 * 1024 * 1024);
  });
});

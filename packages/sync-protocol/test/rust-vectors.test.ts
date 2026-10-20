import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { deriveSpaceKeys, projectHash } from "../src/crypto.js";
import { openObject, parseHeadEnvelope } from "../src/envelope.js";
import {
  COMMAND_ID_PATTERN,
  ackKey,
  classifyKey,
  commandKey,
  commandTimestamp,
  deviceKey,
  headKey,
  partKey,
  projectKey,
  revokedKey,
  spacePrefix,
} from "../src/keys.js";
import { decodePairingCode, normalizeRelayUrl } from "../src/pairing.js";

// Rust→TS：ATM 3 的 atm-sync-protocol（Rust）写出的东西，手机 App 用的这份代码要逐条打得开、解得出。
// 文件由 Rust 的 tests/rust_sealed.rs 生成并守着（与当前 Rust 代码的输出逐字节一致）。
const here = dirname(fileURLToPath(import.meta.url));
const file = join(here, "../../../apps/desktop/native/sync-protocol/tests/data/rust-sealed.json");
type Part = { key: string; data: unknown };
const vectors = JSON.parse(readFileSync(file, "utf8")) as {
  secrets: { secret: string; kid: string; projectHash: Record<string, string> }[];
  sealed: { name: string; secret: string; logicalKey: string; value: unknown; parts: Part[] }[];
  pairing: { payload: Record<string, string>; code: string }[];
  commandIds: { device: string; nowMs: number; id: string }[];
  keys: Record<string, string>;
};

describe("Rust-written sync documents", () => {
  it("derive the same space keys", async () => {
    expect(vectors.secrets.length).toBeGreaterThanOrEqual(3);
    for (const s of vectors.secrets) {
      const keys = await deriveSpaceKeys(s.secret);
      expect(keys.kid).toBe(s.kid);
      for (const [code, hash] of Object.entries(s.projectHash)) {
        expect(await projectHash(keys, code)).toBe(hash);
      }
    }
  });

  it("open every sealed object, compressed and multi-part included", async () => {
    const names = vectors.sealed.map((s) => s.name);
    expect(names).toEqual(["small", "threshold", "compressed", "multiPart"]);
    for (const s of vectors.sealed) {
      const keys = await deriveSpaceKeys(s.secret);
      const head = parseHeadEnvelope(s.parts[0]!.data);
      const value = await openObject(
        keys,
        s.logicalKey,
        head,
        async (key) => s.parts.find((p) => p.key === key)?.data ?? null,
      );
      expect(value, s.name).toEqual(s.value);
    }
    expect(parseHeadEnvelope(vectors.sealed[2]!.parts[0]!.data).z).toBe(1);
    expect(parseHeadEnvelope(vectors.sealed[1]!.parts[0]!.data).z).toBe(0);
    expect(vectors.sealed[3]!.parts.length).toBeGreaterThanOrEqual(2);
  });

  it("refuse a Rust object opened under another logical key", async () => {
    const s = vectors.sealed[0]!;
    const keys = await deriveSpaceKeys(s.secret);
    await expect(
      openObject(keys, `${s.logicalKey}x`, parseHeadEnvelope(s.parts[0]!.data), async () => null),
    ).rejects.toMatchObject({ code: "DECRYPT_FAILED" });
  });

  it("decode the pairing codes", () => {
    for (const p of vectors.pairing) {
      const decoded = decodePairingCode(p.code);
      expect(decoded).toEqual({ v: 1, ...p.payload, u: normalizeRelayUrl(p.payload.u!) });
    }
  });

  it("build and classify the same keys", () => {
    const k = vectors.keys;
    const space = k.space!;
    const cmd = k.command!;
    expect(spacePrefix(space)).toBe(k.spacePrefix);
    expect(headKey(space)).toBe(k.headKey);
    expect(revokedKey(space)).toBe(k.revokedKey);
    expect(projectKey(space, "0123456789abcdef0123")).toBe(k.projectKey);
    expect(commandKey(space, cmd)).toBe(k.commandKey);
    expect(ackKey(space, cmd)).toBe(k.ackKey);
    expect(deviceKey(space, "m-00aa11bb22cc")).toBe(k.deviceKey);
    expect(partKey(headKey(space), 7)).toBe(k.partKey);
    expect(classifyKey(space, k.partKey!)).toEqual({
      kind: "head",
      logicalKey: k.headKey,
      part: 7,
    });
    expect(classifyKey(space, k.commandKey!)).toEqual({
      kind: "command",
      id: cmd,
      logicalKey: k.commandKey,
      part: 0,
    });
  });

  it("read the time back out of Rust command IDs", () => {
    for (const c of vectors.commandIds) {
      expect(COMMAND_ID_PATTERN.test(c.id), c.id).toBe(true);
      expect(c.id.startsWith(`${c.device}.`)).toBe(true);
      expect(commandTimestamp(c.id)).toBe(c.nowMs);
    }
  });
});

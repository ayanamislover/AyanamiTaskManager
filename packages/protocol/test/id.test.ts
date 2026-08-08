import { describe, expect, it } from "vitest";
import { createUlid } from "../src/index.js";

describe("稳定内部标识", () => {
  it("生成 26 位 Crockford ULID，时间递增时保持字典序", () => {
    const entropy = new Uint8Array(10).fill(7);
    const first = createUlid(1_700_000_000_000, entropy);
    const second = createUlid(1_700_000_000_001, entropy);
    expect(first).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(second > first).toBe(true);
  });
});

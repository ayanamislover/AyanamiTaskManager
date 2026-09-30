import { describe, expect, it } from "vitest";
import { encodePairingCode, generateSpace, toBase64Url } from "@ayanami-task/sync-protocol";
import { parsePairingInput, relayLabel } from "../src/data/pairing-input.js";

function validCode(relay = "https://relay.example.com/"): string {
  const space = generateSpace();
  return encodePairingCode({
    v: 1,
    u: relay,
    a: "atm",
    t: "tok_0123456789abcdef",
    s: space.spaceId,
    k: space.secret,
    n: "AYANAMI-PC",
  });
}

function rawCode(payload: unknown): string {
  return `atm1:${toBase64Url(new TextEncoder().encode(JSON.stringify(payload)))}`;
}

describe("配对码解析", () => {
  it("解出完整的配对码，并规范化中继地址", () => {
    const code = validCode();
    const result = parsePairingInput(code);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.u).toBe("https://relay.example.com");
    expect(result.payload.n).toBe("AYANAMI-PC");
    expect(result.code).toBe(code);
  });

  it("容忍前后说明文字、换行断开和大写前缀", () => {
    const code = validCode();
    const body = code.slice("atm1:".length);
    const broken = `配对码：\nATM1:${body.slice(0, 30)}\n${body.slice(30, 70)}  ${body.slice(70)}\n（请勿外传）`;
    const result = parsePairingInput(broken);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.code).toBe(code);
  });

  it("码后面紧跟英文说明时不把说明吞进码里", () => {
    const code = validCode();
    const result = parsePairingInput(`${code} please keep it secret`);
    expect(result.ok).toBe(true);
  });

  it("空输入、非 ATM 文本给出不同的提示", () => {
    const empty = parsePairingInput("   \n ");
    expect(empty).toEqual({ ok: false, error: expect.objectContaining({ code: "EMPTY" }) });
    const foreign = parsePairingInput("https://example.com/invite/abc");
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) {
      expect(foreign.error.code).toBe("NOT_ATM");
      expect(foreign.error.message).toContain("atm1:");
    }
  });

  it("截断的配对码提示「不完整」", () => {
    const code = validCode();
    const cut = parsePairingInput(code.slice(0, 40));
    expect(cut.ok).toBe(false);
    if (!cut.ok) {
      expect(["INCOMPLETE", "INVALID"]).toContain(cut.error.code);
      expect(cut.error.message).toMatch(/不完整|无法识别/);
    }
    const bare = parsePairingInput("atm1:");
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.error.code).toBe("INCOMPLETE");
  });

  it("非本机的 http 中继被拒绝，并说明原因", () => {
    const space = generateSpace();
    const result = parsePairingInput(
      rawCode({
        v: 1,
        u: "http://relay.example.com",
        a: "atm",
        t: "tok_0123456789abcdef",
        s: space.spaceId,
        k: space.secret,
        n: "PC",
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INSECURE_RELAY");
      expect(result.error.message).toContain("https");
    }
  });

  it("本机调试地址允许 http", () => {
    const result = parsePairingInput(validCode("http://127.0.0.1:8790"));
    expect(result.ok).toBe(true);
  });

  it("字段缺失或密钥长度不对时提示重新生成", () => {
    const space = generateSpace();
    const missing = parsePairingInput(rawCode({ v: 1, u: "https://r.example.com", a: "atm" }));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("INVALID");
    const shortKey = parsePairingInput(
      rawCode({
        v: 1,
        u: "https://r.example.com",
        a: "atm",
        t: "tok_0123456789abcdef",
        s: space.spaceId,
        k: "abc",
        n: "PC",
      }),
    );
    expect(shortKey.ok).toBe(false);
  });

  it("中继地址显示为主机名", () => {
    expect(relayLabel("https://relay.example.com")).toBe("relay.example.com");
    expect(relayLabel("http://127.0.0.1:8790")).toBe("127.0.0.1:8790");
    expect(relayLabel("https://cloud.example.com/some/long/prefix/path")).toBe(
      "cloud.example.com/some/long/pref…",
    );
  });
});

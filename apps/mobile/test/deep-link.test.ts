import { describe, expect, it } from "vitest";
import { encodePairingCode, generateSpace } from "@ayanami-task/sync-protocol";
import { interpretDeepLink, isPairingLink } from "../src/data/deep-link.js";

function code(relay = "https://relay.example.com", name = "AYANAMI-PC", spaceId?: string) {
  const space = generateSpace();
  return encodePairingCode({
    v: 1,
    u: relay,
    a: "atm",
    t: "tok_0123456789abcdef",
    s: spaceId ?? space.spaceId,
    k: space.secret,
    n: name,
  });
}

describe("atm1: 深链", () => {
  it("只认 atm1: 开头的链接", () => {
    expect(isPairingLink("atm1:abc")).toBe(true);
    expect(isPairingLink("ATM1:abc")).toBe(true);
    expect(isPairingLink("https://example.com")).toBe(false);
    expect(isPairingLink(null)).toBe(false);
    expect(interpretDeepLink("https://example.com/atm1:x", null)).toEqual({ kind: "ignore" });
    expect(interpretDeepLink(undefined, null)).toEqual({ kind: "ignore" });
  });

  it("未配对时给出待确认的配对，不自动生效", () => {
    const link = code();
    const intent = interpretDeepLink(link, null);
    expect(intent).toMatchObject({ kind: "pair", replaces: null, code: link });
    if (intent.kind === "pair") {
      expect(intent.payload.n).toBe("AYANAMI-PC");
      expect(intent.payload.u).toBe("https://relay.example.com");
    }
  });

  it("已配对时说明会替换当前配对", () => {
    const intent = interpretDeepLink(code("https://other.example.com", "别人的电脑"), {
      s: "0123456789abcdef01234567",
      u: "https://relay.example.com",
      n: "AYANAMI-PC",
    });
    expect(intent).toMatchObject({
      kind: "pair",
      replaces: { hostName: "AYANAMI-PC", relay: "https://relay.example.com", sameSpace: false },
    });
  });

  it("同一个空间重新扫码标记为 sameSpace", () => {
    const spaceId = "0123456789abcdef01234567";
    const intent = interpretDeepLink(code("https://relay.example.com", "AYANAMI-PC", spaceId), {
      s: spaceId,
      u: "https://relay.example.com",
      n: "AYANAMI-PC",
    });
    expect(intent).toMatchObject({ kind: "pair", replaces: { sameSpace: true } });
  });

  it("百分号编码过的链接也能解", () => {
    const link = code();
    const encoded = `atm1:${encodeURIComponent(link.slice(5)).replace(/-/g, "%2D")}`;
    expect(interpretDeepLink(encoded, null).kind).toBe("pair");
  });

  it("坏链接给出可读的错误而不是静默忽略", () => {
    const intent = interpretDeepLink("atm1:bm90LWpzb24", null);
    expect(intent.kind).toBe("invalid");
    if (intent.kind === "invalid") expect(intent.error.message.length).toBeGreaterThan(4);
  });
});

import type { PairingPayload } from "@ayanami-task/sync-protocol";
import { parsePairingInput, type PairingInputError } from "./pairing-input.js";

/**
 * 系统相机 / 任意扫码器扫到电脑上的二维码，或 `adb shell am start -d "atm1:…"`，
 * 都会以 `atm1:` 深链拉起 App。深链可能来自任何人发来的链接，所以**从不自动配对**：
 * 一律先给用户看「将与谁配对、连哪个中继」，点确认才生效；已配对时还要说明会替换。
 */
export type DeepLinkIntent =
  | { kind: "ignore" }
  | { kind: "invalid"; error: PairingInputError }
  | { kind: "pair"; payload: PairingPayload; code: string; replaces: null }
  | {
      kind: "pair";
      payload: PairingPayload;
      code: string;
      replaces: { hostName: string; relay: string; sameSpace: boolean };
    };

export type CurrentPairing = { s: string; u: string; n: string } | null;

export function isPairingLink(url: string | null | undefined): url is string {
  return typeof url === "string" && /^atm1:/i.test(url.trim());
}

export function interpretDeepLink(
  url: string | null | undefined,
  current: CurrentPairing,
): DeepLinkIntent {
  if (!isPairingLink(url)) return { kind: "ignore" };
  // 有的扫码器会把 base64url 里的字符百分号编码后再交给系统。
  let text = url.trim();
  try {
    text = decodeURIComponent(text);
  } catch {
    // 不是合法的百分号编码：按原样解析。
  }
  const parsed = parsePairingInput(text);
  if (!parsed.ok) return { kind: "invalid", error: parsed.error };
  if (!current) return { kind: "pair", payload: parsed.payload, code: parsed.code, replaces: null };
  return {
    kind: "pair",
    payload: parsed.payload,
    code: parsed.code,
    replaces: {
      hostName: current.n,
      relay: current.u,
      sameSpace: current.s === parsed.payload.s && current.u === parsed.payload.u,
    },
  };
}

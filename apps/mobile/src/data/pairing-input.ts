import {
  PAIRING_PREFIX,
  decodePairingCode,
  isSyncProtocolError,
  type PairingPayload,
} from "@ayanami-task/sync-protocol";

export type PairingInputError = {
  code: "EMPTY" | "NOT_ATM" | "INCOMPLETE" | "INSECURE_RELAY" | "INVALID";
  message: string;
};

export type PairingInputResult =
  | { ok: true; payload: PairingPayload; code: string }
  | { ok: false; error: PairingInputError };

// 配对码字符集：base64url。电脑上复制时可能带换行、空格，或者整段说明文字。
const STRICT_PATTERN = /atm1:[A-Za-z0-9_-]*/i;
const LOOSE_PATTERN = /atm1:[\sA-Za-z0-9_-]*/i;

/**
 * 从用户粘贴或扫到的文本里找出配对码并解码。
 *
 * 容忍三种常见情况：前后有说明文字（「配对码：atm1:…」）、中间被换行或空格断开、
 * 前缀大小写不一致。先按不含空白的连续一段试；不行再把断开的几行拼起来试——
 * 反过来的话，码后面紧跟的英文说明会被当成码的一部分。
 * 真正的格式校验交给 sync-protocol 的 decodePairingCode，这里只把它的错误翻成用户能照着做的提示。
 */
export function parsePairingInput(text: string): PairingInputResult {
  const trimmed = text.trim();
  if (!trimmed) return fail("EMPTY", "请先粘贴或扫描配对码");
  const strict = STRICT_PATTERN.exec(trimmed)?.[0];
  if (strict === undefined) {
    return fail(
      "NOT_ATM",
      "这不是 ATM 配对码：配对码以 atm1: 开头，请在电脑 ATM「设置 → 手机同步」里复制",
    );
  }
  const loose = LOOSE_PATTERN.exec(trimmed)?.[0] ?? strict;
  const candidates = [...new Set([strict, loose].map(normalizeCode))];
  let first: PairingInputResult | null = null;
  for (const code of candidates) {
    const result = decodeCandidate(code);
    if (result.ok) return result;
    first ??= result;
  }
  return first ?? fail("INVALID", "配对码无法识别，请在电脑上重新生成后再试");
}

function normalizeCode(raw: string): string {
  return PAIRING_PREFIX + raw.slice(PAIRING_PREFIX.length).replace(/\s+/g, "");
}

function decodeCandidate(code: string): PairingInputResult {
  if (code.length <= PAIRING_PREFIX.length) {
    return fail("INCOMPLETE", "配对码不完整，请在电脑上重新复制完整的一段");
  }
  try {
    return { ok: true, payload: decodePairingCode(code), code };
  } catch (error) {
    if (isSyncProtocolError(error) && error.code === "RELAY_URL_INVALID") {
      return fail(
        "INSECURE_RELAY",
        "配对码里的中继地址不是 https。除本机调试地址外，手机只连接 https 中继",
      );
    }
    if (isSyncProtocolError(error) && /不完整/.test(error.message)) {
      return fail("INCOMPLETE", "配对码不完整，可能少复制了一截。请在电脑上重新复制完整的一段");
    }
    return fail("INVALID", "配对码无法识别，请在电脑上重新生成后再试");
  }
}

function fail(code: PairingInputError["code"], message: string): PairingInputResult {
  return { ok: false, error: { code, message } };
}

/** 显示用：只保留协议和主机名，路径过长时省略。 */
export function relayLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.host}${path.length > 16 ? `${path.slice(0, 15)}…` : path}`;
  } catch {
    return url;
  }
}

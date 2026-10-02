// PUT 请求体解析。
//
// 为什么不直接 JSON.parse 再 JSON.stringify 回去：中继必须**原样**保存 `data`。
// 经过一次 JS 数值往返，`12345678901234567890` 会变成 `12345678901234567000`，`1.0` 会变成 `1`，
// 而 AyanamiCloud（Go 的 json.RawMessage）保存的是原文。这里先用 JSON.parse 校验整体合法，
// 再用一个只认结构、不解释数值的扫描器切出顶层各成员的原文片段。
import { badRequest } from "./errors.js";

/** 与 Go encoding/json 的嵌套上限一致：超过就拒绝，免得一个 30 万层的数组拖慢扫描。 */
const MAX_NESTING = 10_000;

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function isWs(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function skipWs(text: string, index: number): number {
  let i = index;
  while (i < text.length && isWs(text.charCodeAt(i))) i++;
  return i;
}

/** text[index] 是开引号；返回闭引号之后的位置。调用前整段已经过 JSON.parse 校验。 */
function skipString(text: string, index: number): number {
  let i = index + 1;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === 0x5c) i += 2;
    else if (code === 0x22) return i + 1;
    else i++;
  }
  return i;
}

function skipValue(text: string, index: number, depthBudget: number): number {
  const first = text.charCodeAt(index);
  if (first === 0x22) return skipString(text, index);
  if (first === 0x7b || first === 0x5b) {
    let depth = 0;
    let i = index;
    while (i < text.length) {
      const code = text.charCodeAt(i);
      if (code === 0x22) {
        i = skipString(text, i);
        continue;
      }
      if (code === 0x7b || code === 0x5b) {
        depth++;
        if (depth > depthBudget) throw badRequest("请求体嵌套层数过深");
      } else if (code === 0x7d || code === 0x5d) {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    return i;
  }
  let i = index;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === 0x2c || code === 0x7d || code === 0x5d || isWs(code)) break;
    i++;
  }
  return i;
}

/** 顶层对象各成员的原文。重复键取最后一个，与 JSON.parse 和 Go 的行为一致。 */
function topLevelMembers(text: string): Map<string, string> {
  const members = new Map<string, string>();
  let i = skipWs(text, 0);
  if (text.charCodeAt(i) !== 0x7b) return members;
  i = skipWs(text, i + 1);
  while (i < text.length && text.charCodeAt(i) !== 0x7d) {
    const keyEnd = skipString(text, i);
    const key = JSON.parse(text.slice(i, keyEnd)) as string;
    i = skipWs(text, keyEnd) + 1; // 冒号
    i = skipWs(text, i);
    const valueEnd = skipValue(text, i, MAX_NESTING - 1);
    members.set(key, text.slice(i, valueEnd));
    i = skipWs(text, valueEnd);
    if (text.charCodeAt(i) === 0x2c) i = skipWs(text, i + 1);
  }
  return members;
}

/** 去掉字符串之外的空白。输出给客户端的 `data` 与 AyanamiCloud 一样是紧凑形式。 */
export function compactJson(raw: string): string {
  let out = "";
  let start = 0;
  let i = 0;
  while (i < raw.length) {
    const code = raw.charCodeAt(i);
    if (code === 0x22) {
      i = skipString(raw, i);
      continue;
    }
    if (isWs(code)) {
      out += raw.slice(start, i);
      while (i < raw.length && isWs(raw.charCodeAt(i))) i++;
      start = i;
      continue;
    }
    i++;
  }
  return start === 0 ? raw : out + raw.slice(start);
}

export type PutBody = {
  expectedRevision: number | null;
  /** `data` 的原文；缺省为 null。JSON 字面量 `null` 是合法数据，得到字符串 "null"。 */
  dataRaw: string | null;
  schemaVersion: number | null;
  deviceId: string | null;
  keepCandidate: boolean;
};

function integerMember(raw: string | undefined, name: string): number | null {
  if (raw === undefined || raw === "null") return null;
  // Go 把 1.0、1e2 解到 int64 会报类型错误；这里按字面量判断，而不是看 JSON.parse 之后是不是整数。
  if (!/^-?(?:0|[1-9]\d*)$/.test(raw)) throw badRequest(`${name} 必须是整数`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw badRequest(`${name} 超出范围`);
  return value;
}

/**
 * 解析 PUT 体。只做「能不能读懂」这一层（错误码 BAD_REQUEST）；
 * 缺字段、负数、超大等语义校验由调用方做（INVALID_ARGUMENT / 413），顺序与 AyanamiCloud 相同。
 */
export function parsePutBody(bytes: Buffer): PutBody {
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    throw badRequest("请求体不是合法的 UTF-8");
  }
  if (text.trim() === "") throw badRequest("请求体为空");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw badRequest("请求体不是合法 JSON");
  }
  if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) {
    throw badRequest("请求体必须是 JSON 对象");
  }
  const members = parsed === null ? new Map<string, string>() : topLevelMembers(text);

  const deviceRaw = members.get("device_id");
  let deviceId: string | null = null;
  if (deviceRaw !== undefined && deviceRaw !== "null") {
    const value = JSON.parse(deviceRaw) as unknown;
    if (typeof value !== "string") throw badRequest("device_id 必须是字符串");
    deviceId = value === "" ? null : value;
  }
  const keepRaw = members.get("keep_candidate");
  if (keepRaw !== undefined && keepRaw !== "null" && keepRaw !== "true" && keepRaw !== "false") {
    throw badRequest("keep_candidate 必须是布尔值");
  }
  const dataRaw = members.get("data");
  return {
    expectedRevision: integerMember(members.get("expected_revision"), "expected_revision"),
    dataRaw: dataRaw === undefined ? null : dataRaw,
    schemaVersion: integerMember(members.get("schema_version"), "schema_version"),
    deviceId,
    keepCandidate: keepRaw === "true",
  };
}

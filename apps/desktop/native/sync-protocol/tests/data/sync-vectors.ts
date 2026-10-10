// 手机同步线格式的 TS→Rust 向量（W7a）。直接用手机 App 用的 `packages/sync-protocol` 源码生成，
// 另用 node:crypto 独立派生一遍钥（不经过被测的 TS），构造 TS 公开接口造不出来的负例（解压炸弹、坏压缩流、
// BOM、非 UTF-8 明文）。负例记下 TS 抛出的错误码与完整的提示文字，Rust 必须一字不差。
//
// 用法（仓库根）：pnpm exec tsx apps/desktop/native/sync-protocol/tests/data/sync-vectors.ts
// 输出：同目录的 sync-vectors.json。TS 加密用随机 IV，所以每次生成的密文不同；已知答案的部分用固定 IV。
import { createCipheriv, createHash, createHmac, hkdfSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

import {
  AckDocSchema,
  CommandDocSchema,
  DeviceDocSchema,
  HeadDocSchema,
  PairingPayloadSchema,
  ProjectDocSchema,
  ProjectHeadSchema,
  RevokedDocSchema,
  TaskCardSchema,
  TaskCreateBodySchema,
  TaskDispatchBodySchema,
  ackKey,
  classifyKey,
  commandKey,
  commandTimestamp,
  decodePairingCode,
  deriveSpaceKeys,
  deviceKey,
  encodePairingCode,
  headKey,
  normalizeRelayUrl,
  openObject,
  parseHeadEnvelope,
  partKey,
  projectHash,
  projectKey,
  revokedKey,
  sealObject,
  spacePrefix,
  toBase64Url,
  isSyncProtocolError,
  APP_ID_PATTERN,
  COMMAND_ID_PATTERN,
  DEVICE_ID_PATTERN,
  DOC_KEY_PATTERN,
  PROJECT_CODE_PATTERN,
  PROJECT_HASH_PATTERN,
  SPACE_ID_PATTERN,
  TASK_KEY_PATTERN,
} from "../../../../../../packages/sync-protocol/src/index.ts";
import { AckResultSchema } from "../../../../../../packages/sync-protocol/src/schemas.ts";

const here = dirname(fileURLToPath(import.meta.url));
const MAX = 16 * 1024 * 1024;

/** 运行 f，返回结果或 {error: code, message}；不是协议错误的记 {error: "<类名>"}。 */
async function outcome<T>(
  f: () => Promise<T> | T,
): Promise<{ ok: T } | { error: string; message?: string }> {
  try {
    return { ok: await f() };
  } catch (e) {
    if (isSyncProtocolError(e)) return { error: e.code, message: e.message };
    return { error: (e as Error).constructor.name };
  }
}

// ---- 钥 ----
const secretOf = (fill: (i: number) => number) =>
  toBase64Url(Uint8Array.from({ length: 32 }, (_, i) => fill(i)));
const SECRETS = [
  secretOf(() => 0),
  secretOf((i) => i),
  secretOf((i) => (i * 73 + 41) & 255),
  secretOf(() => 255),
];

function rawKeys(secret: string) {
  const raw = Buffer.from(secret, "base64url");
  const derive = (info: string) => Buffer.from(hkdfSync("sha256", raw, "atm-sync/v1", info, 32));
  return { aead: derive("aead"), names: derive("names") };
}
const hmac = (key: Buffer, msg: string) =>
  createHmac("sha256", key).update(msg, "utf8").digest("hex");

const keys = [];
for (const secret of SECRETS) {
  const k = await deriveSpaceKeys(secret);
  const raw = rawKeys(secret);
  if (hmac(raw.names, "kid").slice(0, 8) !== k.kid) throw new Error("independent kid differs");
  const codes = ["ATM", "A", "Z9_-X", "项目"];
  keys.push({
    secret,
    kid: k.kid,
    aead: raw.aead.toString("hex"),
    names: raw.names.toString("hex"),
    hmac: { kid: hmac(raw.names, "kid"), "": hmac(raw.names, ""), 日本: hmac(raw.names, "日本") },
    projectHash: Object.fromEntries(
      await Promise.all(codes.map(async (c) => [c, await projectHash(k, c)])),
    ),
  });
}
const badSecrets = [];
for (const secret of [
  "",
  "short",
  SECRETS[0] + "A",
  SECRETS[0].slice(0, 42),
  SECRETS[0].slice(0, 42) + "+",
  "A".repeat(44),
]) {
  badSecrets.push({ secret, ...(await outcome(() => deriveSpaceKeys(secret).then((k) => k.kid))) });
}

// ---- 加密对象：TS 加密、Rust 打开 ----
const secret = SECRETS[2];
const spaceKeys = await deriveSpaceKeys(secret);
const raw = rawKeys(secret);
const SPACE = "0123456789abcdef01234567";
const values: Record<string, unknown> = {
  small: { v: 1, text: "你好 😀", n: 3, list: [1, 2.5, -0, null, true], nested: { a: "\u2028" } },
  empty: {},
  compressible: { v: 1, text: "ATM ".repeat(2000) },
  threshold: { s: "x".repeat(1024 - 8) },
};
const sealed = [];
for (const [name, value] of Object.entries(values)) {
  const logicalKey = `atm1/${SPACE}/p/${"0123456789abcdef0123"}`;
  const parts = await sealObject(spaceKeys, logicalKey, value);
  sealed.push({ name, secret, logicalKey, parts, value });
}

// ---- 已知答案：固定 IV、不压缩，Rust 加密必须逐字节相同 ----
function sealFixed(
  logicalKey: string,
  plaintext: Buffer,
  iv: Buffer,
  z: 0 | 1,
  overrides: Record<string, unknown> = {},
) {
  const c = createCipheriv("aes-256-gcm", raw.aead, iv);
  c.setAAD(Buffer.from(logicalKey, "utf8"));
  const ct = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
  const head = {
    v: 1,
    kid: spaceKeys.kid,
    iv: iv.toString("base64url"),
    z,
    n: 1,
    d: createHash("sha256").update(ct).digest("hex").slice(0, 16),
    c: ct.toString("base64url"),
    ...overrides,
  };
  return { key: logicalKey, data: head };
}
const knownAnswer = [];
for (const [i, value] of [
  { v: 1, a: "x" },
  { text: "你好 😀", n: [1, 2, 3], b: false },
  { s: "y".repeat(1016) },
].entries()) {
  const logicalKey = `atm1/${SPACE}/head`;
  const iv = Buffer.alloc(12, i + 1);
  const part = sealFixed(logicalKey, Buffer.from(JSON.stringify(value), "utf8"), iv, 0);
  // 自检：TS 打得开。
  const opened = await openObject(
    spaceKeys,
    logicalKey,
    parseHeadEnvelope(part.data),
    async () => null,
  );
  if (JSON.stringify(opened) !== JSON.stringify(value))
    throw new Error("known answer does not open in TS");
  knownAnswer.push({ secret, logicalKey, iv: iv.toString("hex"), value, parts: [part] });
}

// ---- 打开的负例 ----
const opens = [];
async function openCase(
  name: string,
  logicalKey: string,
  parts: { key: string; data: unknown }[],
  openKey = logicalKey,
  useSecret = secret,
) {
  const k = await deriveSpaceKeys(useSecret);
  const r = await outcome(async () => {
    const head = parseHeadEnvelope(parts[0]!.data);
    const v = await openObject(
      k,
      openKey,
      head,
      async (key) => parts.find((p) => p.key === key)?.data ?? null,
    );
    return typeof v === "string" && v.length > 1000 ? { stringLength: v.length } : v;
  });
  opens.push({ name, secret: useSecret, logicalKey: openKey, parts, ...r });
}
// 多片：不可压缩的 base64url 串，长度调到恰好两片、第 1 片很小（负例的改动都落在第 1 片上，向量文件不必
// 一遍遍存第 0 片的 16 万字符）。负例记 edits，Rust 照着改同一份分片再打开。
const random64 = (n: number, seed: number) => {
  const chunks: Buffer[] = [];
  let i = 0;
  while (chunks.length * 32 < n)
    chunks.push(createHash("sha256").update(`${seed}:${i++}`).digest());
  return Buffer.concat(chunks).toString("base64url").slice(0, n);
};
const multiKey = `atm1/${SPACE}/p/0123456789abcdef0123`;
let multiValue: unknown = null;
let multiParts: { key: string; data: Record<string, unknown> }[] = [];
for (let n = 118_000; ; n += 100) {
  const value = { v: 1, blob: random64(n, 1) };
  const parts = (await sealObject(spaceKeys, multiKey, value)) as typeof multiParts;
  if (parts.length === 2 && (parts[1]!.data.c as string).length < 2000) {
    multiValue = value;
    multiParts = parts;
    break;
  }
  if (parts.length > 2) throw new Error("multi-part sizing overshot");
}
const multi = { secret, logicalKey: multiKey, parts: multiParts, value: multiValue };

type Edit =
  | { remove: number }
  | { part: number; set: Record<string, unknown> }
  | { part: number; replace: unknown };
function applyEdits(edits: Edit[]) {
  const parts = JSON.parse(JSON.stringify(multiParts)) as typeof multiParts;
  for (const e of edits) {
    if ("remove" in e) parts.splice(e.remove, 1);
    else if ("set" in e) Object.assign(parts[e.part]!.data, e.set);
    else parts[e.part]!.data = e.replace as Record<string, unknown>;
  }
  return parts;
}
async function multiCase(name: string, edits: Edit[], openKey = multiKey, useSecret = secret) {
  const k = await deriveSpaceKeys(useSecret);
  const parts = applyEdits(edits);
  const r = await outcome(async () => {
    const head = parseHeadEnvelope(parts[0]!.data);
    return await openObject(
      k,
      openKey,
      head,
      async (key) => parts.find((p) => p.key === key)?.data ?? null,
    );
  });
  const result =
    "ok" in r
      ? { ok: JSON.stringify(r.ok) === JSON.stringify(multiValue) ? "<multi.value>" : r.ok }
      : r;
  opens.push({ name, base: "multi", edits, secret: useSecret, logicalKey: openKey, ...result });
}
const c1 = multiParts[1]!.data.c as string;
const d0 = multiParts[0]!.data.d as string;
await multiCase("ok", []);
await multiCase("wrong secret", [], multiKey, SECRETS[1]);
await multiCase("wrong logical key (AAD)", [], `atm1/${SPACE}/p/ffffffffffffffffffff`);
await multiCase("missing part", [{ remove: 1 }]);
await multiCase("part from another version", [{ part: 1, set: { d: "0000000000000000" } }]);
await multiCase("part index mismatch", [{ part: 1, set: { i: 2 } }]);
await multiCase("malformed part", [{ part: 1, replace: { v: 1, d: d0 } }]);
await multiCase("part version 2", [{ part: 1, set: { v: 2 } }]);
await multiCase("part with extra field", [{ part: 1, set: { extra: "ignored" } }]);
await multiCase("tampered chunk", [
  { part: 1, set: { c: (c1[0] === "A" ? "B" : "A") + c1.slice(1) } },
]);
await multiCase("iv not base64url", [{ part: 0, set: { iv: "!!!!!!!!!!!!!!!!" } }]);
await multiCase("chunk not base64url length", [{ part: 1, set: { c: c1 + "A" } }]);
await multiCase("chunk with a non-base64url character", [
  { part: 1, set: { c: c1.slice(0, -1) + "=" } },
]);

// 单片的负例：固定 IV 自己加密，控制明文与压缩。
const one = (name: string, plaintext: Buffer, z: 0 | 1, overrides: Record<string, unknown> = {}) =>
  openCase(name, `atm1/${SPACE}/head`, [
    sealFixed(`atm1/${SPACE}/head`, plaintext, Buffer.alloc(12, 9), z, overrides),
  ]);
await one("plain JSON", Buffer.from('{"a":1}'), 0);
await one(
  "BOM then JSON",
  Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')]),
  0,
);
await one("not UTF-8", Buffer.from([0x7b, 0xff, 0x7d]), 0);
await one("not JSON", Buffer.from("hello"), 0);
await one("JSON with duplicate keys", Buffer.from('{"a":1,"a":2}'), 0);
await one("deflated JSON", deflateRawSync(Buffer.from(JSON.stringify({ s: "z".repeat(5000) }))), 1);
await one(
  "deflate exactly at the limit",
  deflateRawSync(Buffer.from(`"${"a".repeat(MAX - 2)}"`)),
  1,
);
await one("deflate bomb one byte over", deflateRawSync(Buffer.from(`"${"a".repeat(MAX - 1)}"`)), 1);
await one(
  "truncated deflate stream",
  deflateRawSync(Buffer.from(JSON.stringify({ s: "q".repeat(5000) }))).subarray(0, 20),
  1,
);
await one("corrupt deflate stream", Buffer.from([0xff, 0xff, 0xff, 0xff, 0x00]), 1);
await one("z=1 on plain bytes", Buffer.from('{"a":1}'), 1);
// fflate 的实测边界：空输入解出空内容；结束块之后的字节不管；完整但没有结束标志的块、单个 0 字节都是坏流。
await one("empty deflate stream", Buffer.alloc(0), 1);
await one(
  "deflate with trailing bytes",
  Buffer.concat([deflateRawSync(Buffer.from('{"a":1}')), Buffer.from([1, 2, 3])]),
  1,
);
await one(
  "stored block without the final flag",
  Buffer.from([0x00, 0x07, 0x00, 0xf8, 0xff, ...Buffer.from('{"a":1}')]),
  1,
);
await one(
  "stored final block",
  Buffer.from([0x01, 0x07, 0x00, 0xf8, 0xff, ...Buffer.from('{"a":1}')]),
  1,
);
await one("final empty fixed block", Buffer.from([0x03, 0x00]), 1);
await one("single zero byte", Buffer.from([0x00]), 1);
await one("kid of another space", Buffer.from('{"a":1}'), 0, { kid: "00000000" });

// ---- 信封结构 ----
const headCases = [];
const goodHead = {
  v: 1,
  kid: "0123abcd",
  iv: "AAAAAAAAAAAAAAAA",
  z: 0,
  n: 1,
  d: "0123456789abcdef",
  c: "",
};
const headInputs: [string, unknown][] = [
  ["good", goodHead],
  [
    "v as 1.0 text",
    JSON.parse(
      '{"v":1.0,"kid":"0123abcd","iv":"AAAAAAAAAAAAAAAA","z":0,"n":1,"d":"0123456789abcdef","c":""}',
    ),
  ],
  ["extra field", { ...goodHead, x: 1 }],
  ["v=2", { ...goodHead, v: 2 }],
  ["kid upper", { ...goodHead, kid: "0123ABCD" }],
  ["kid 7", { ...goodHead, kid: "0123abc" }],
  ["iv 15", { ...goodHead, iv: "AAAAAAAAAAAAAAA" }],
  ["iv 16 non-ascii", { ...goodHead, iv: "AAAAAAAAAAAAAAA€" }],
  ["iv 16 code units with emoji", { ...goodHead, iv: "AAAAAAAAAAAAAA😀" }],
  ["z=2", { ...goodHead, z: 2 }],
  ["z=true", { ...goodHead, z: true }],
  ["n=0", { ...goodHead, n: 0 }],
  ["n=64", { ...goodHead, n: 64 }],
  ["n=65", { ...goodHead, n: 65 }],
  ["n=1.5", { ...goodHead, n: 1.5 }],
  ["n as string", { ...goodHead, n: "1" }],
  ["d upper", { ...goodHead, d: "0123456789ABCDEF" }],
  ["c at the limit", { ...goodHead, c: { repeatA: 160_000 } }],
  ["c over the limit", { ...goodHead, c: { repeatA: 160_001 } }],
  ["missing c", (({ c: _c, ...r }) => r)(goodHead)],
  ["null", null],
  ["array", [goodHead]],
];
// `{ repeatA: n }` 表示 n 个 "A"（向量里不存长串）。
const expand = (x: unknown): unknown => {
  if (x && typeof x === "object" && !Array.isArray(x)) {
    const o = x as Record<string, unknown>;
    if (typeof o.repeatA === "number" && Object.keys(o).length === 1) return "A".repeat(o.repeatA);
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, expand(v)]));
  }
  return x;
};
for (const [name, input] of headInputs) {
  const r = await outcome(() => {
    const h = parseHeadEnvelope(expand(input));
    return { ...h, c: h.c.length > 100 ? `<${h.c.length}>` : h.c };
  });
  headCases.push({ name, input, ...r });
}

// ---- 键 ----
const patterns: Record<string, RegExp> = {
  DOC_KEY: DOC_KEY_PATTERN,
  APP_ID: APP_ID_PATTERN,
  SPACE_ID: SPACE_ID_PATTERN,
  DEVICE_ID: DEVICE_ID_PATTERN,
  COMMAND_ID: COMMAND_ID_PATTERN,
  PROJECT_HASH: PROJECT_HASH_PATTERN,
  PROJECT_CODE: PROJECT_CODE_PATTERN,
  TASK_KEY: TASK_KEY_PATTERN,
};
const CMD = "pc-0123456789ab.0lfz1x2y3z4ab01234567";
const samples = [
  "",
  "a",
  "ab",
  "A",
  "Z",
  "ATM",
  "atm",
  "ATM-T-0001",
  "ATM-T-001",
  "ATM-T-12345",
  "A-T-1234-T-5678",
  "A-T--T-1234",
  "ATM_X-Y9",
  "A".repeat(32),
  "A".repeat(33),
  "AB".repeat(16) + "-T-0001",
  "AB".repeat(17) + "-T-0001",
  "1AB",
  "pc-0123456789ab",
  "m-0123456789ab",
  "pc-0123456789AB",
  "pc-0123456789a",
  "x-0123456789ab",
  CMD,
  CMD.toUpperCase(),
  "m-0123456789ab.zzzzzzzzzzzzzffffffff",
  "pc-0123456789ab.0lfz1x2y3z4ab0123456",
  "0123456789abcdef01234567",
  "0123456789abcdef0123",
  "0123456789abcdef012",
  "atm1/0123456789abcdef01234567/head",
  "a b",
  "a/b.c-d_e",
  "x".repeat(200),
  "x".repeat(201),
  "é",
  "ATM-T-٠١٢٣",
  "app_1",
  "_app",
  "a-",
  "z".repeat(32),
  "z".repeat(33),
  "ATM\n",
  "\nATM",
];
const patternCases = samples.map((s) => ({
  s,
  ...Object.fromEntries(Object.entries(patterns).map(([n, re]) => [n, re.test(s)])),
}));

const builders = [];
for (const [fn, args] of [
  ["spacePrefix", [SPACE]],
  ["headKey", [SPACE]],
  ["revokedKey", [SPACE]],
  ["headKey", ["0123"]],
  ["projectKey", [SPACE, "0123456789abcdef0123"]],
  ["projectKey", [SPACE, "XYZ"]],
  ["commandKey", [SPACE, CMD]],
  ["commandKey", [SPACE, "pc-0123456789ab"]],
  ["ackKey", [SPACE, CMD]],
  ["ackKey", [SPACE, "x"]],
  ["deviceKey", [SPACE, "m-0123456789ab"]],
  ["deviceKey", [SPACE, "m-01"]],
  ["partKey", ["k", 1]],
  ["partKey", ["k", 999]],
  ["partKey", ["k", 0]],
  ["partKey", ["k", 1000]],
] as [string, unknown[]][]) {
  const f = {
    spacePrefix,
    headKey,
    revokedKey,
    projectKey,
    commandKey,
    ackKey,
    deviceKey,
    partKey,
  }[fn] as (...a: unknown[]) => string;
  builders.push({ fn, args, ...(await outcome(() => f(...args))) });
}
const P = `atm1/${SPACE}/`;
const classify = [
  P + "head",
  P + "head.1",
  P + "head.999",
  P + "head.1000",
  P + "head.0",
  P + "head.007",
  P + "revoked",
  P + "revoked.2",
  P + "p/0123456789abcdef0123",
  P + "p/0123456789abcdef0123.3",
  P + "p/0123456789abcdef012",
  P + "p/",
  P + "cmd/" + CMD,
  P + "cmd/" + CMD + ".1",
  P + "ack/" + CMD,
  P + "dev/pc-0123456789ab",
  P + "dev/pc-0123456789ab.12",
  P + "dev/pc-0123456789ab/x",
  P + "other/x",
  P + "",
  P + "p",
  "atm1/ffffffffffffffffffffffff/head",
  "x/head",
  P + "head x",
  P + "head.12.3",
  P + "cmd/" + CMD + "x",
].map((key) => ({ space: SPACE, key, result: classifyKey(SPACE, key) }));
classify.push({ space: "bad", key: P + "head", result: classifyKey("bad", P + "head") });
const timestamps = [
  CMD,
  "m-0123456789ab.zzzzzzzzzzzzzffffffff",
  "m-0123456789ab.0000000000000ffffffff",
  "pc-x",
].map((id) => ({
  id,
  ms: commandTimestamp(id),
}));

// ---- 配对 ----
const urls = [
  "https://relay.example.com",
  "https://relay.example.com/",
  "https://relay.example.com/api//",
  " https://Relay.Example.com:443/a/../b/ ",
  "https://relay.example.com:8443/x",
  "http://127.0.0.1:8787",
  "http://localhost/",
  "http://LOCALHOST:1/",
  "http://[::1]:9/",
  "http://127.1/",
  "http://relay.example.com",
  "ftp://relay.example.com",
  "https://user@relay.example.com",
  "https://:pw@relay.example.com",
  "https://relay.example.com/?",
  "https://relay.example.com/?a=1",
  "https://relay.example.com/#",
  "https://relay.example.com/#x",
  "not a url",
  "",
  "https://例子.测试/路径",
  "https://relay.example.com/a%20b",
  "\u3000https://relay.example.com\u3000",
  "https://relay.example.com/\u00a0",
].map((u) => ({
  input: u,
  ...(() => {
    try {
      return { ok: normalizeRelayUrl(u) };
    } catch (e) {
      return { error: (e as { code: string }).code, message: (e as Error).message };
    }
  })(),
}));

const payload = {
  v: 1 as const,
  u: "https://relay.example.com/",
  a: "atm",
  t: "tok-12345678",
  s: SPACE,
  k: SECRETS[1]!,
  n: "我的电脑",
};
const encodeCases = [];
for (const [name, p] of [
  ["good", payload],
  ["empty name", { ...payload, n: "" }],
  ["loopback http", { ...payload, u: "http://127.0.0.1:8787/" }],
  ["short token", { ...payload, t: "1234567" }],
  ["bad app", { ...payload, a: "A" }],
  ["long name", { ...payload, n: "x".repeat(65) }],
  ["bad url", { ...payload, u: "http://relay.example.com" }],
] as [string, typeof payload][]) {
  encodeCases.push({ name, payload: p, ...(await outcome(() => encodePairingCode(p))) });
}
const goodCode = encodePairingCode(payload);
const body = (o: unknown) => "atm1:" + Buffer.from(JSON.stringify(o)).toString("base64url");
const decodeCases = [];
for (const [name, code] of [
  ["good", goodCode],
  ["with whitespace", goodCode.slice(0, 10) + " \n\t\u3000" + goodCode.slice(10)],
  ["no prefix", goodCode.slice(5)],
  ["upper prefix", "ATM1:" + goodCode.slice(5)],
  ["truncated", goodCode.slice(0, -3)],
  ["not base64", "atm1:@@@@"],
  ["not json", "atm1:" + Buffer.from("hello").toString("base64url")],
  ["missing field", body({ ...payload, n: undefined })],
  ["v=2", body({ ...payload, v: 2 })],
  ["secret wrong length", body({ ...payload, k: "A".repeat(43).slice(0, 42) + "=" })],
  ["secret not base64url", body({ ...payload, k: "+".repeat(43) })],
  ["url not https", body({ ...payload, u: "http://relay.example.com" })],
  ["url normalized", body({ ...payload, u: "HTTPS://RELAY.example.com:443/x/" })],
  ["extra field", body({ ...payload, extra: 1 })],
  ["empty", ""],
] as [string, string][]) {
  decodeCases.push({ name, code, ...(await outcome(() => decodePairingCode(code))) });
}

// ---- 明文结构 ----
const card = {
  key: "ATM-T-0001",
  title: "标题",
  type: "TASK",
  status: "READY",
  priority: "NORMAL",
  progress: 40,
  updatedAt: "2026-10-10T00:00:00.000Z",
};
const fullCard = {
  ...card,
  parent: "ATM-T-0000",
  claim: { agent: "claude", since: "t" },
  waiting: "w",
  blocked: "b",
  desc: "d",
  acceptance: ["a", "b"],
  checklist: { done: 1, total: 2 },
  recent: [{ at: "t", summary: "s", percent: 50 }],
  dispatch: { state: "running", at: "t", run: "r1", error: "e" },
};
const counts = { active: 1, ready: 0, inProgress: 0, blocked: 0, waitingUser: 0, doneRecent: 3 };
const projectHead = {
  code: "ATM",
  name: "n",
  h: "0123456789abcdef0123",
  d: "x",
  counts,
  updatedAt: "t",
};
const headDoc = {
  v: 1,
  host: { id: "pc-0123456789ab", name: "PC", app: "3.0.0" },
  at: "t",
  dispatch: { enabled: true, mode: "auto", running: 0 },
  projects: [projectHead],
};
const projectDoc = { v: 1, code: "ATM", name: "n", at: "t", tasks: [card, fullCard] };
const createBody = {
  project: "ATM",
  title: "  买菜  ",
  description: "d",
  priority: "HIGH",
  dispatch: true,
};
const command = {
  v: 1,
  id: CMD,
  device: { id: "m-0123456789ab", name: "OnePlus 9" },
  at: "t",
  type: "task.create",
  body: createBody,
};
const dispatchCommand = {
  ...command,
  type: "task.dispatch",
  body: { project: "ATM", key: "ATM-T-0001" },
};
const ackOk = {
  v: 1,
  id: CMD,
  at: "t",
  ok: true,
  result: { project: "ATM", key: "ATM-T-0002", dispatch: { run: "r", state: "queued" } },
};
const ackErr = { v: 1, id: CMD, at: "t", ok: false, error: { code: "X", message: "m" } };
const device = {
  v: 1,
  id: "m-0123456789ab",
  name: "OnePlus 9",
  kind: "android",
  role: "client",
  app: "1.0",
  at: "t",
  state: "online",
};
const revoked = { v: 1, at: "t", host: { id: "pc-0123456789ab", name: "PC" } };
const pairing = { ...payload, u: "https://relay.example.com" };

const W = (s: string) => s; // 让下面的空白字符一眼看得出是有意的
const schemaInputs: [string, unknown][] = [
  ["TaskCard", card],
  ["TaskCard", fullCard],
  ["TaskCard", { ...card, extra: 1 }],
  ["TaskCard", { ...card, progress: 100.5 }],
  ["TaskCard", { ...card, progress: 12.5 }],
  ["TaskCard", { ...card, progress: -0 }],
  ["TaskCard", { ...card, title: "😀".repeat(250) }],
  ["TaskCard", { ...card, title: "😀".repeat(251) }],
  ["TaskCard", { ...card, parent: null }],
  ["TaskCard", { ...card, status: "DONE " }],
  ["TaskCard", { ...card, acceptance: Array(13).fill("a") }],
  ["TaskCard", { ...card, checklist: { done: 1.5, total: 2 } }],
  ["TaskCard", { ...card, checklist: { done: 2 ** 53, total: 2 ** 53 } }],
  ["TaskCard", { ...card, checklist: { done: 2 ** 53 - 1, total: 0 } }],
  [
    "TaskCard",
    {
      ...card,
      recent: [
        { at: "t", summary: "s" },
        { at: "t", summary: "s" },
        { at: "t", summary: "s" },
        { at: "t", summary: "s" },
      ],
    },
  ],
  ["TaskCard", { ...card, dispatch: { state: "queued", at: "", run: "r" } }],
  ["TaskCard", { ...card, updatedAt: "x".repeat(65) }],
  ["TaskCard", { ...card, claim: { since: "t" } }],
  ["TaskCard", { ...card, claim: { agent: "a", extra: [1] } }],
  ["ProjectHead", projectHead],
  ["ProjectHead", { ...projectHead, d: "" }],
  ["ProjectHead", { ...projectHead, counts: { ...counts, ready: -1 } }],
  ["HeadDoc", headDoc],
  ["HeadDoc", { ...headDoc, v: 2 }],
  ["HeadDoc", { ...headDoc, dispatch: { ...headDoc.dispatch, mode: "default" } }],
  ["HeadDoc", { ...headDoc, dispatch: { ...headDoc.dispatch, enabled: "true" } }],
  ["HeadDoc", { ...headDoc, projects: [] }],
  ["ProjectDoc", projectDoc],
  ["ProjectDoc", { ...projectDoc, tasks: [{ ...card, key: "atm-T-1" }] }],
  ["TaskCreateBody", createBody],
  ["TaskCreateBody", { project: "ATM", title: W("\ufeff\u3000x\u2028") }],
  ["TaskCreateBody", { project: "ATM", title: W("\u0085x") }],
  ["TaskCreateBody", { project: "ATM", title: "   " }],
  ["TaskCreateBody", { project: "ATM", title: " " + "😀".repeat(100) + " " }],
  ["TaskCreateBody", { project: "ATM", title: "😀".repeat(100) + "a" }],
  ["TaskCreateBody", { project: "ATM", title: "x", description: "y".repeat(8001) }],
  ["TaskCreateBody", { project: "ATM", title: 1 }],
  ["TaskDispatchBody", { project: "ATM", key: "ATM-T-0001" }],
  ["TaskDispatchBody", { project: "ATM" }],
  ["CommandDoc", command],
  ["CommandDoc", dispatchCommand],
  ["CommandDoc", { ...command, type: "task.delete" }],
  ["CommandDoc", { ...dispatchCommand, body: createBody }],
  ["CommandDoc", (({ type: _t, ...r }) => r)(command)],
  ["CommandDoc", { ...command, id: "pc-0123456789ab" }],
  ["AckResult", ackOk.result],
  ["AckDoc", ackOk],
  ["AckDoc", ackErr],
  ["AckDoc", { ...ackOk, ok: false }],
  ["AckDoc", { ...ackErr, ok: "false" }],
  [
    "AckDoc",
    {
      ...ackOk,
      result: { ...ackOk.result, dispatchError: { code: "DISPATCH_DISABLED", message: "m" } },
    },
  ],
  ["DeviceDoc", device],
  ["DeviceDoc", { ...device, kind: "ios" }],
  ["DeviceDoc", { ...device, state: "away" }],
  ["RevokedDoc", revoked],
  ["RevokedDoc", { ...revoked, extra: 1 }],
  ["RevokedDoc", { ...revoked, host: { ...revoked.host, extra: 1 } }],
  ["PairingPayload", pairing],
  ["PairingPayload", { ...pairing, k: "A".repeat(44) }],
  ["PairingPayload", { ...pairing, u: "" }],
];
const schemaMap: Record<
  string,
  { safeParse: (x: unknown) => { success: boolean; data?: unknown } }
> = {
  TaskCard: TaskCardSchema,
  ProjectHead: ProjectHeadSchema,
  HeadDoc: HeadDocSchema,
  ProjectDoc: ProjectDocSchema,
  TaskCreateBody: TaskCreateBodySchema,
  TaskDispatchBody: TaskDispatchBodySchema,
  CommandDoc: CommandDocSchema,
  AckResult: AckResultSchema,
  AckDoc: AckDocSchema,
  DeviceDoc: DeviceDocSchema,
  RevokedDoc: RevokedDocSchema,
  PairingPayload: PairingPayloadSchema,
};
const schemas = schemaInputs.map(([schema, input]) => {
  const r = schemaMap[schema]!.safeParse(input);
  return r.success ? { schema, input, ok: r.data } : { schema, input, ok: null };
});

const out = {
  note: "Generated by sync-vectors.ts from packages/sync-protocol; do not edit by hand.",
  keys,
  badSecrets,
  sealed,
  multi,
  knownAnswer,
  opens,
  headCases,
  patternCases,
  builders,
  classify,
  timestamps,
  urls,
  encodeCases,
  decodeCases,
  schemas,
};
writeFileSync(join(here, "sync-vectors.json"), JSON.stringify(out) + "\n");
console.log(
  `sync-vectors.json: ${sealed.length} sealed, ${opens.length} opens, ${schemas.length} schema cases`,
);

// 幂等指纹的独立期望（W2b；02 §3.4、§9.3；10 R3、R3′）。不经过 atm-service 的任何代码。
//
// - kernel-v1：照抄 2.x `packages/storage-sqlite/src/project-mutation-kernel.ts:24-41` 的
//   canonicalize + requestFingerprint。键用 localeCompare 排序，结果由运行本脚本的 node 的 ICU 决定
//   （2.x 打包的就是官方 full-icu node）。
// - knowledge-v1：照抄 `knowledge-repository.ts:108`、`:160-165`：sha256(JSON.stringify(payload))，不排序；
//   Agent 保存的键是 "agent:" + sha256(JSON.stringify([projectId, sessionId, opId]))。
// - canon-v2：RFC 8785（JCS）：键按 UTF-16 码元排序（Array.prototype.sort 的默认比较），
//   数字与字符串的写法同 JSON.stringify。
//
// 输入用带类型标签的编码传给 Rust，保住 undefined 与 null 的区别，数字按 float64 位模式传：
//   ["u"] undefined，["z"] null，["b", bool]，["n", "<16 位十六进制位模式>"]，["s", str]，
//   ["a", [...]]，["o", [[key, value], ...]]（顺序即对象的属性顺序）。
//
// 用法：node fp-vectors.mjs <输出目录>
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const ch = (...codes) => String.fromCharCode(...codes);

// ---- 2.x 原码（只改了缩进） ----
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}
function requestFingerprint(value) {
  return sha(JSON.stringify(canonicalize(value)) ?? "null");
}
// ---- 原码结束 ----

function jcs(v) {
  if (v === undefined) return undefined;
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map((x) => jcs(x) ?? "null").join(",") + "]";
  const keys = Object.keys(v)
    .filter((k) => v[k] !== undefined)
    .sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + jcs(v[k])).join(",") + "}";
}

function enc(v) {
  if (v === undefined) return ["u"];
  if (v === null) return ["z"];
  if (typeof v === "boolean") return ["b", v];
  if (typeof v === "number") {
    const b = Buffer.alloc(8);
    b.writeDoubleBE(v);
    return ["n", b.toString("hex")];
  }
  if (typeof v === "string") return ["s", v];
  if (Array.isArray(v)) return ["a", v.map(enc)];
  return ["o", Object.entries(v).map(([k, x]) => [k, enc(x)])];
}

// mulberry32，固定种子
let seed = 0x5eed2b;
function rand() {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (xs) => xs[Math.floor(rand() * xs.length)];

const STRINGS = [
  "",
  "plain",
  "中文标题",
  "混合 mixed 文本",
  "a" + ch(10) + "b" + ch(9) + "c" + ch(13),
  ch(0, 1, 31, 127),
  ch(8, 12),
  ch(0x2028, 0x2029),
  "😀 emoji " + ch(0xd83d, 0xde00),
  'quote " and ' + ch(92) + " backslash",
  "/slash/",
  "é" + ch(0x301),
  "ＡＴＭ-T-0001",
];
const NUMBERS = [
  0,
  -0,
  1,
  -1,
  42,
  0.1 + 0.2,
  1e21,
  1e-7,
  123456789012345680000,
  5e-324,
  1.7976931348623157e308,
  2 ** 53,
  -(2 ** 53) - 2,
  1.5,
  100,
  NaN,
  Infinity,
  -Infinity,
];

// kernel-v1 唯一允许的键形 ^[A-Za-z][A-Za-z0-9]*$；字母表故意挤在大小写与数字上，考验比较器。
const KEY_HEAD = "aAbBmMtTeEzZ";
const KEY_TAIL = "aAbBmMtTeEzZ09";
function asciiKey() {
  let k = pick([...KEY_HEAD]);
  const n = Math.floor(rand() * 5);
  for (let i = 0; i < n; i++) k += pick([...KEY_TAIL]);
  return k;
}
// v2 的键可以是任意字符串：含非 ASCII、星位字符（UTF-16 序与码点序不同）、数字样式。
const WIDE_KEYS = [
  "",
  "a",
  "A",
  "b",
  "aa",
  "é",
  "中",
  "文",
  ch(0xd83d, 0xde00),
  ch(0xff5a),
  ch(0xe000),
  "10",
  "2",
  "-1",
  "01",
  "key with space",
  "camelCase",
  "snake_case",
  "dash-key",
];

function value(depth, key) {
  const r = rand();
  if (depth > 0 && r < 0.18) return object(depth - 1, key);
  if (depth > 0 && r < 0.3) return array(depth - 1, key);
  if (r < 0.5) return pick(STRINGS);
  if (r < 0.72) return pick(NUMBERS);
  if (r < 0.8) return rand() < 0.5;
  if (r < 0.9) return null;
  return undefined;
}
function array(depth, key) {
  const n = Math.floor(rand() * 4);
  return Array.from({ length: n }, () => value(depth, key));
}
function object(depth, key) {
  const o = {};
  const n = 1 + Math.floor(rand() * 5);
  for (let i = 0; i < n; i++) o[key()] = value(depth, key);
  return o;
}

const kernel = [];
function addKernel(name, input) {
  kernel.push({
    name,
    input: enc(input),
    canonical: JSON.stringify(canonicalize(input)) ?? null,
    fp: requestFingerprint(input),
  });
}

// 02 §3.4 的原子 begin 示例：规范 JSON 与指纹首尾都写在规格里。
const begin = {
  projectCode: "ATM",
  cwd: null,
  title: null,
  mode: "auto",
  agentId: "codex",
  displayName: "codex",
  clientKind: "generic",
  parentSessionId: null,
  threadId: null,
  role: "PRIMARY",
  gitBranch: null,
  gitHead: null,
  resume: false,
  predecessorSessionId: null,
  signals: {},
  allowProjectCreate: false,
  creationReason: null,
};
addKernel("spec-begin-example", begin);
const beginFp = requestFingerprint(begin);
if (!beginFp.startsWith("4af53325") || !beginFp.endsWith("f915b")) {
  throw new Error("02 §3.4 begin example does not reproduce: " + beginFp);
}
// review.submit 形状：reviewedHashes 与 reviewTaskKey 的 ICU 序与字节序相反（02 §3.4）。
const review = {
  requestKey: "ATM-RR-0001",
  reviewTaskKey: "ATM-T-0042",
  expectedReviewTaskVersion: 3,
  verdict: "APPROVED",
  reviewedHashes: [{ name: "git", value: "abc1234" }],
  evidence: [],
};
addKernel("review-submit-shape", review);
const byteSorted = (v) =>
  Array.isArray(v)
    ? v.map(byteSorted)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v)
            .filter(([, x]) => x !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, x]) => [k, byteSorted(x)]),
        )
      : v;
if (sha(JSON.stringify(byteSorted(review))) === requestFingerprint(review)) {
  throw new Error("review.submit should differ between ICU and byte order");
}
addKernel("work-progress-with-chinese", {
  taskKey: "ATM-T-0007",
  summary: "完成 W2a，进入 W2b",
  completed: ["状态机", { text: "完成门", workItemKey: "ATM-T-0008" }],
  next: [],
  evidence: [{ kind: "git_sha", value: "7055025" }, "docs/report.md"],
  percent: 40,
  blocker: undefined,
});
addKernel("case-pairs", {
  a: 1,
  A: 2,
  b: 3,
  B: 4,
  aB: 5,
  ab: 6,
  Ab: 7,
  AB: 8,
  a0: 9,
  a9: 10,
  aa: 11,
});
addKernel("opid-operation", { opId: "x", operation: "y", op: "z", oP: "w" });
addKernel("undefined-everywhere", {
  a: undefined,
  b: [undefined, 1, undefined],
  c: { d: undefined },
});
addKernel("top-level-undefined", undefined);
addKernel("top-level-null", null);
addKernel("top-level-array", [3, "x", { b: 1, a: 2 }]);
addKernel("top-level-string", "中文");
addKernel("top-level-number", 0.1 + 0.2);
for (let i = 0; i < 400; i++) addKernel("random-" + i, object(3, asciiKey));

// kernel-v1 无法复现、必须拒绝（FP_V1_UNSUPPORTED_KEY）的键：不在 ^[A-Za-z][A-Za-z0-9]*$ 里。
const unsupported = [
  ["digit-first", { "1a": 1 }, "1a"],
  ["underscore", { ok: 1, a_b: 2 }, "a_b"],
  ["dash", { "a-b": 1 }, "a-b"],
  ["non-ascii", { 中文: 1 }, "中文"],
  ["empty", { "": 1 }, ""],
  ["index-like", { b: 1, 10: 2 }, "10"],
  ["nested", { ok: { deeper: [{ "bad key": 1 }] } }, "bad key"],
].map(([name, input, key]) => ({ name, input: enc(input), key }));

// knowledge-v1：固定键序（zod schema 的 shape 顺序），不排序。
const knowledge = [];
function addKnowledge(name, payload) {
  knowledge.push({
    name,
    input: enc(payload),
    json: JSON.stringify(payload),
    fp: sha(JSON.stringify(payload)),
  });
}
addKnowledge("user-save", {
  operation: "save",
  slug: "w2-idempotency",
  title: "幂等指纹",
  summary: "按族保留 fp_v1",
  useWhen: "实现回执查找时",
  tags: ["atm3", "幂等"],
  aliases: [],
  appliesTo: ["ATM"],
  bodyMarkdown: "# 标题" + ch(10) + ch(10) + "正文 with `code`",
  sourceRefs: [
    {
      type: "atm_record",
      reference: "ATM-D-308",
      sourceVersion: 1,
      projectId: "P1",
      recordId: undefined,
    },
  ],
  opId: "op-user-1",
  id: undefined,
  expectedVersion: 0,
  expectedRevisionId: undefined,
});
addKnowledge("user-archive", {
  operation: "archive",
  opId: "op-archive",
  id: "K1",
  expectedVersion: 3,
  expectedRevisionId: "R3",
  archived: true,
});
addKnowledge("agent-save", {
  operation: "agent.save",
  slug: "s",
  title: "T",
  summary: "S",
  useWhen: "",
  tags: [],
  aliases: [],
  appliesTo: [],
  bodyMarkdown: "正文",
  sourceRefs: [],
  project: "PROJECT-ID",
  session: "SESSION-1",
  opId: "op-agent-1",
  author: { type: "AGENT", agentId: "codex", sessionId: "SESSION-1", projectId: "PROJECT-ID" },
});
// 创建顺序与枚举顺序不同：数组下标形状的键（0..=2^32-2 的规范十进制）被 JSON.stringify 按数值升序挪到最前，
// 其余保持创建顺序。JS 对象记不住整数键的创建顺序，所以输入按创建顺序手写，再逐个赋值得到 JS 对象。
function addKnowledgeCreated(name, entries) {
  const payload = {};
  for (const [k, v] of entries) payload[k] = v;
  knowledge.push({
    name,
    input: ["o", entries.map(([k, v]) => [k, enc(v)])],
    json: JSON.stringify(payload),
    fp: sha(JSON.stringify(payload)),
  });
}
addKnowledgeCreated("index-keys-hoisted", [
  ["b", 1],
  ["10", 2],
  ["a", 3],
  ["2", 4],
  ["01", 5],
  ["4294967294", 6],
  ["4294967295", 7],
  ["-1", 8],
  ["1.5", 9],
]);
for (let i = 0; i < 60; i++) {
  const keys = [
    "operation",
    "slug",
    "title",
    "summary",
    "tags",
    "opId",
    "expectedVersion",
    "extra",
  ];
  const o = {};
  for (const k of keys) if (rand() < 0.85) o[k] = value(2, () => pick(WIDE_KEYS));
  addKnowledge("random-" + i, o);
}
const agentKeys = [
  ["PROJECT-ID", "SESSION-1", "op-agent-1"],
  ["P", "S", "中文 op"],
  ["01M3Y8SPASS456V67ED4GQAW10", "01M40PKB7K806HEY7VPW72RS97", "auto:01M40QT34JXJP0B0AN5YZ7V1RB"],
].map(([project, session, op]) => ({
  project,
  session,
  op,
  key: "agent:" + sha(JSON.stringify([project, session, op])),
}));

// canon-v2：任意键。
const v2 = [];
function addV2(name, input) {
  const canonical = jcs(input) ?? null;
  v2.push({ name, input: enc(input), canonical, fp: sha(canonical ?? "null") });
}
addV2("utf16-order", { [ch(0xff5a)]: 1, [ch(0xd83d, 0xde00)]: 2, [ch(0xe000)]: 3, a: 4 });
addV2("index-like-keys", { b: 1, 10: 2, 2: 3, a: 4, "-1": 5 });
addV2("review-submit-shape", review);
addV2("undefined", { a: undefined, b: [undefined], c: null });
addV2("top-level-undefined", undefined);
for (let i = 0; i < 300; i++)
  addV2(
    "random-" + i,
    object(3, () => pick(WIDE_KEYS)),
  );

const out = process.argv[2] ?? ".";
writeFileSync(
  join(out, "fp-vectors.json"),
  JSON.stringify({
    node: process.version,
    icu: process.versions.icu,
    kernel,
    unsupported,
    knowledge,
    agentKeys,
    v2,
  }),
);
console.log(
  `kernel ${kernel.length}, unsupported ${unsupported.length}, knowledge ${knowledge.length}, v2 ${v2.length}`,
);

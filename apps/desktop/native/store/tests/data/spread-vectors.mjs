// 2.0 补投影 payload 的独立期望（W1 peer r2 P1-r2-01、r3 P1-r3-01 / P1-r3-02）。
// 按 2.0 的 outbox-read-model.ts `readJson`（JSON.parse，空值或失败回退 {}）、
// registry-projection-dispatcher.ts 的对象展开、再 JSON.stringify 生成，不经过本 crate 的任何代码。
//
// 用法：node spread-vectors.mjs <输出目录>
// 输出：
// - spread-vectors.json：{ node, maxDepth, vectors: [{ name, eventId, sequence, source, mirror, spread }], refused: [{ name, source }] }
//   mirror 是该事件补出镜像的完整 payload，spread 是单纯的 `{ ...readJson(source) }`。
//   refused 是嵌套超过 maxDepth 的合法 JSON：转换器必须显式拒绝，不能清空后通过。
// - numbers.json：{ node, numbers: [[f64 的 16 位十六进制位模式, JSON.stringify(x)], ...] }
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_DEPTH = 2048; // 与 atm_store::jsjson::MAX_DEPTH 一致
const B = String.fromCharCode(92); // 反斜杠：源文本里的转义都用它拼，文件里不出现字面的转义序列
const HI = String.fromCharCode(0xd800);
const LO = String.fromCharCode(0xdc00);
const u = (hex) => B + "u" + hex;

function readJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function deep(levels) {
  let v = "leaf";
  for (let i = 0; i < levels; i++) v = [v];
  return v;
}

const vectors = [
  ["array-mixed", '["keep-me", 1, true, null, {"a":[1]}]'],
  ["string-xy", '"xy"'],
  ["string-escapes", '"a😀é' + B + "n" + u("0001") + B + '"' + B + B + '"'],
  ["string-lone-high", '"' + u("d83d") + '"'],
  ["number", "42"],
  ["true", "true"],
  ["null", "null"],
  ["invalid", "not json {"],
  ["object-int-keys", '{"b":1,"2":"two","a":{"x":null}}'],
  ["string-empty", '""'],
  ["array-empty", "[]"],
  ["number-exponent", "-1.5e3"],
  ["object-spoofed-project", '{"projectId":"spoofed","keep":1}'],
  ["array-nested", '[[1,"x"],[],{"b":false},false]'],
  [
    "string-short-escapes",
    '"' + B + "b" + B + "f" + B + "t" + u("001f") + u("2028") + u("007f") + B + '/"',
  ],
  ["string-surrogates", '"' + u("dc00") + "x" + u("d83d") + u("de00") + '"'],
  // r3 P1-r3-01：数组元素不能经过 SQLite 值转换
  ["array-lone-high", JSON.stringify([HI])],
  ["array-lone-low", JSON.stringify([LO])],
  [
    "array-strings",
    JSON.stringify([
      "😀",
      "a" + LO + "b",
      ["x" + HI],
      { k: LO + HI },
      "é" + String.fromCharCode(0x2028),
    ]),
  ],
  [
    "array-numbers",
    JSON.stringify([
      0.12345678901234568,
      1.2345678901234567,
      Number.MAX_VALUE,
      9007199254740991,
      1e-300,
      Number.MIN_VALUE,
      1e21,
      1e-7,
      123e-20,
      -0,
      0.1,
      100,
      1.5e300,
      -2.5e-8,
      4294967296.5,
    ]),
  ],
  [
    "numbers-raw-text",
    "[1e400, -1e400, 1.0, 1E2, -0, 0.0000001, 2e-7, 1e+21, 123456789012345678901234, 5e-324, 2.4e-324]",
  ],
  ["object-numbers", '{"a":1e21,"b":-0.0,"c":0.30000000000000004}'],
  // 对象语义：重复键、数组下标形状的键、__proto__、转义的键名
  ["object-duplicate-keys", '{"a":1,"b":2,"a":3}'],
  [
    "object-index-keys",
    '{"b":1,"10":2,"2":3,"01":4,"4294967295":5,"4294967294":6,"-1":7,"1.5":8,"0":9}',
  ],
  ["object-proto-key", '{"__proto__":{"x":1},"y":2}'],
  ["object-escaped-key", '{"source' + u("0045") + 'ventId":"zzz","keep":1}'],
  ["object-unicode-keys", '{"é":1,"a":2,"' + u("d800") + '":3}'],
  ["whitespace", ' \t\n\r{"a" : [ 1 , 2 ] }\r\n'],
  // JSON.parse 不接受的
  ["invalid-trailing-comma", "[1,]"],
  ["invalid-vertical-tab", String.fromCharCode(11) + "[1]"],
  ["invalid-raw-control", '"a' + String.fromCharCode(1) + 'b"'],
  ["invalid-signed-escape", '"' + B + 'u+fff"'],
  ["invalid-leading-zero", "01"],
  ["invalid-bare-point", "1."],
  ["invalid-nbsp-whitespace", String.fromCharCode(0xa0) + "1"],
  // r3 P1-r3-02：SQLite 的深度上限（1000）两侧，以及本 crate 的上限
  ...[999, 1000, 1001, 1100, MAX_DEPTH - 1].map((n) => [
    `deep-object-${n + 1}`,
    JSON.stringify({ keep: deep(n) }),
  ]),
  ...[999, 1000, 1001, 1100, MAX_DEPTH].map((n) => [`deep-array-${n}`, JSON.stringify(deep(n))]),
];

const refused = [
  [`deep-object-${MAX_DEPTH + 1}`, JSON.stringify({ keep: deep(MAX_DEPTH) })],
  [`deep-array-${MAX_DEPTH + 1}`, JSON.stringify(deep(MAX_DEPTH + 1))],
];

// 测试把第 i 条向量作为项目 P1 的事件 `SV<i>`（序号 100 + i）插入夹具，一次转换补出全部镜像。
const project = (eventId, sequence) => ({
  projectId: "P1",
  projectCode: "AAA",
  projectName: "Alpha",
  projectSequence: sequence,
  sourceEventId: eventId,
  sourceProjectSequence: sequence,
  sourceAggregateType: "WORK_ITEM",
  sourceAggregateId: "W1",
});

const out = vectors.map(([name, source], i) => {
  const payload = readJson(source, {});
  const eventId = `SV${String(i).padStart(3, "0")}`;
  const sequence = 100 + i;
  return {
    name,
    eventId,
    sequence,
    source,
    mirror: JSON.stringify({ ...payload, ...project(eventId, sequence) }),
    spread: JSON.stringify({ ...payload }),
  };
});
for (const [, source] of refused) {
  JSON.stringify({ ...JSON.parse(source), ...project("X", 1) }); // node 本身能处理：拒绝是本 crate 的边界，不是非法 JSON
}

const dir = process.argv[2];
writeFileSync(
  join(dir, "spread-vectors.json"),
  JSON.stringify(
    {
      node: process.version,
      maxDepth: MAX_DEPTH,
      vectors: out,
      refused: refused.map(([name, source]) => ({ name, source })),
    },
    null,
    1,
  ) + "\n",
);

// 数字：特殊值、10 的幂、2^53 附近、随机位模式、随机“好看”的小数。
const view = new DataView(new ArrayBuffer(8));
const bits = (x) => {
  view.setFloat64(0, x);
  return view.getBigUint64(0).toString(16).padStart(16, "0");
};
const numbers = new Map();
const add = (x) => {
  if (Number.isFinite(x)) numbers.set(bits(x), JSON.stringify(x));
};
[
  0,
  -0,
  1,
  -1,
  0.1,
  0.2,
  0.30000000000000004,
  1 / 3,
  2 / 3,
  Math.PI,
  Math.E,
  Number.MAX_VALUE,
  Number.MIN_VALUE,
  Number.EPSILON,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 2,
  2 ** 53,
  2 ** 64,
  2 ** 32 - 1,
  2 ** 31,
  1e21,
  1e21 - 65536,
  999999999999999900000,
  1e-6,
  1e-7,
  1.5e-7,
  123456789,
  0.000001234,
  5e-324,
  2.2250738585072014e-308,
  2.225073858507201e-308,
].forEach(add);
for (let e = -330; e <= 310; e++) {
  add(Number(`1e${e}`));
  add(Number(`7.5e${e}`));
  add(-Number(`3.3333333333333335e${e}`));
}
// 固定种子（mulberry32），文件可复现。
let seed = 0x5eed2026;
const random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const u32 = () => Math.floor(random() * 4294967296);
// 最短位数下两个候选与 x 等距（x 的精确十进制展开恰好多一位、末位是 5）时，JS 取末位为偶数的那个
// （W1 peer r4 P2-08）。二进制分数 a + b / 2^k 的精确展开短，这种情况多。
// eslint-disable-next-line no-loss-of-precision -- 这两个字面量就是要 JS 自己按最短位数取整的输入
[1951.0000610351562, -1951.0000610351562].forEach(add);
for (let i = 0; i < 4000; i++) {
  const k = 8 + Math.floor(random() * 40);
  const a = Math.floor(random() * 2 ** Math.floor(random() * 40));
  const b = Math.floor(random() * 2 ** Math.min(k, 30)) * 2 ** Math.max(0, k - 30) + 1;
  const x = (a + b / 2 ** k) * (random() < 0.5 ? 1 : -1) * 10 ** (Math.floor(random() * 9) - 4);
  add(x);
  add(a + b / 2 ** k);
}
for (let i = 0; numbers.size < 12000 && i < 100000; i++) {
  view.setUint32(0, u32());
  view.setUint32(4, u32());
  add(view.getFloat64(0));
  add(Math.round(random() * 1e6) / 10 ** Math.floor(random() * 12));
}
writeFileSync(
  join(dir, "numbers.json"),
  JSON.stringify({ node: process.version, numbers: [...numbers.entries()] }) + "\n",
);
console.log(out.length, refused.length, numbers.size);

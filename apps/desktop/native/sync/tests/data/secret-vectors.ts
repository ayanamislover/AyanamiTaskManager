// 同步密钥文件的 TS→Rust 向量（W7b）。直接跑 2.x 的 `apps/desktop/src/dpapi-secret-store.ts` 与
// `packages/sync/src/secret-store.ts`（SecretVault），记下每一步读到的值与写完后文件的全部字节；Rust 照同样的
// 步骤重放，读到的值与写出的文件必须一字节不差。加解密换成确定的假实现（与 tests/secrets.rs 的 `Fake` 相同），
// 这样文件内容可复现；DPAPI 本身的互通由 tests/secrets.rs 里独立写的 2.x 调用守着。
//
// 用法（仓库根）：pnpm exec tsx apps/desktop/native/sync/tests/data/secret-vectors.ts
// 输出：同目录的 secret-vectors.json。临时目录在仓库的 output/ 下，跑完删掉。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DpapiSecretStore } from "../../../../src/dpapi-secret-store.ts";
import type { Dpapi } from "../../../../src/dpapi.ts";
import { SECRET_NAMES, SecretVault } from "../../../../../../packages/sync/src/secret-store.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../../../..");
const PREFIX = Buffer.from("fake:");
const u = (...codes: number[]) => String.fromCharCode(...codes);

/** 确定的假加密：`fake:` + 每字节异或 0x5a；解密要求前缀。 */
const fake: Dpapi = {
  protect: async (data) => Buffer.concat([PREFIX, Buffer.from(data.map((b) => b ^ 0x5a))]),
  unprotect: async (sealed) => {
    if (!sealed.subarray(0, PREFIX.length).equals(PREFIX)) throw new Error("not ours");
    return Buffer.from(sealed.subarray(PREFIX.length).map((b) => b ^ 0x5a));
  },
};
const sealedB64 = async (plain: Buffer | string) =>
  (await fake.protect(Buffer.from(plain))).toString("base64");

type Name = "relay" | "space";
const NAME = { relay: SECRET_NAMES.relayToken, space: SECRET_NAMES.spaceSecret } as const;
type Op =
  | { op: "read"; name: Name }
  | { op: "write"; name: Name; value: string }
  | { op: "remove"; name: Name }
  | { op: "vault-load"; spaceId: string | null }
  | { op: "set-token"; token: string | null }
  | { op: "set-space"; spaceId: string; secret: string };
type Case = { name: string; initial: Buffer | null; ops: Op[] };

const relayA = await sealedB64("atr_first");
const relayB = await sealedB64("atr_second");
const space1 = await sealedB64("space-1:pairing-secret");

const cases: Case[] = [
  {
    name: "fresh directory",
    initial: null,
    ops: [
      { op: "read", name: "relay" },
      { op: "remove", name: "relay" },
      { op: "write", name: "relay", value: "atr_secret-token" },
      { op: "write", name: "space", value: "space-1:pairing-secret" },
      { op: "read", name: "relay" },
      { op: "read", name: "space" },
      { op: "write", name: "relay", value: "atr_replaced" + u(0x4ee4, 0x724c) + "\u{1F600}" },
      { op: "read", name: "relay" },
      { op: "remove", name: "relay" },
      { op: "read", name: "relay" },
      { op: "read", name: "space" },
      { op: "remove", name: "space" },
      { op: "write", name: "space", value: "" },
      { op: "read", name: "space" },
    ],
  },
  ...["{broken", "[]", "null", '"text"', "12", ""].map(
    (text): Case => ({
      name: `not an object: ${JSON.stringify(text)}`,
      initial: Buffer.from(text),
      ops: [
        { op: "read", name: "space" },
        { op: "write", name: "space", value: "space-2:secret" },
        { op: "read", name: "space" },
      ],
    }),
  ),
  {
    name: "key order, odd keys and non-string values",
    initial: Buffer.from(
      `{"b":"1","9":"x","2":"y","relay-token":"","a\\u0001\\"\\\\${u(0x2028)}\\u001f":"q",` +
        `"num":1,"obj":{},"b":"3","4294967295":"z","01":"w","4294967294":"v","nul":null}`,
    ),
    ops: [
      { op: "read", name: "relay" },
      { op: "write", name: "space", value: "space-3:s" },
      { op: "remove", name: "relay" },
      { op: "write", name: "relay", value: "atr_t" },
    ],
  },
  {
    name: "a raw control character is not JSON",
    initial: Buffer.from(`{"a${u(1)}":"q","relay-token":"${relayA}"}`),
    ops: [
      { op: "read", name: "relay" },
      { op: "write", name: "space", value: "space-8:s" },
    ],
  },
  {
    name: "a BOM makes the file unreadable",
    initial: Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(`{"relay-token":"${relayA}"}`),
    ]),
    ops: [
      { op: "read", name: "relay" },
      { op: "write", name: "space", value: "space-4:s" },
    ],
  },
  {
    name: "whitespace around the JSON, compact layout",
    initial: Buffer.from(` \r\n\t{"relay-token" : "${relayA}"}\n\n `),
    ops: [
      { op: "read", name: "relay" },
      { op: "write", name: "relay", value: "atr_rewritten" },
    ],
  },
  {
    name: "lenient base64",
    initial: Buffer.from(
      JSON.stringify({
        "relay-token": `${relayA.slice(0, 5)} \n${relayA.slice(5, 9)}@${relayA.slice(9)}`
          .replaceAll("+", "-")
          .replaceAll("/", "_"),
        "space-secret": `${space1.replace(/=+$/u, "")}`,
      }),
    ),
    ops: [
      { op: "read", name: "relay" },
      { op: "read", name: "space" },
    ],
  },
  {
    name: "padding stops the decoding",
    initial: Buffer.from(JSON.stringify({ "relay-token": `${relayA}=${relayB}` })),
    ops: [{ op: "read", name: "relay" }],
  },
  {
    name: "values that do not open",
    initial: Buffer.from(
      JSON.stringify({
        "relay-token": Buffer.from("not sealed by us").toString("base64"),
        "space-secret": "@@@",
      }),
    ),
    ops: [
      { op: "read", name: "relay" },
      { op: "read", name: "space" },
      { op: "vault-load", spaceId: "space-1" },
    ],
  },
  {
    name: "plaintext that is not UTF-8",
    initial: Buffer.from(
      JSON.stringify({
        "relay-token": await sealedB64(Buffer.from([0x61, 0xff, 0xc3, 0x28, 0xe2, 0x82])),
      }),
    ),
    ops: [{ op: "read", name: "relay" }],
  },
  {
    name: "a file that is not UTF-8",
    initial: Buffer.concat([
      Buffer.from('{"x":"'),
      Buffer.from([0xff, 0xc3]),
      Buffer.from(`","relay-token":"${relayA}"}`),
    ]),
    ops: [
      { op: "read", name: "relay" },
      { op: "write", name: "space", value: "space-5:s" },
    ],
  },
  {
    name: "a repeated key: the last value, the first position",
    initial: Buffer.from(
      `{"relay-token":"${relayA}","space-secret":"${space1}","relay-token":"${relayB}"}`,
    ),
    ops: [
      { op: "read", name: "relay" },
      { op: "write", name: "space", value: "space-6:s" },
    ],
  },
  {
    name: "vault",
    initial: Buffer.from(
      JSON.stringify({ "relay-token": await sealedB64(""), "space-secret": space1 }),
    ),
    ops: [
      { op: "vault-load", spaceId: "space-1" },
      { op: "vault-load", spaceId: "space-2" },
      { op: "vault-load", spaceId: null },
      { op: "set-token", token: "atr_vault" },
      { op: "vault-load", spaceId: "space-1" },
      { op: "set-space", spaceId: "space-7", secret: "with:colon" },
      { op: "vault-load", spaceId: "space-7" },
      { op: "set-token", token: "" },
      { op: "vault-load", spaceId: "space-7" },
      { op: "set-token", token: "atr_again" },
      { op: "set-token", token: null },
      { op: "set-token", token: null },
    ],
  },
];

const work = mkdtempSync(join(repo, "output", "secret-vectors-"));
const out: unknown[] = [];
try {
  let counter = 0;
  for (const c of cases) {
    const directory = join(work, `case-${(counter += 1)}`, "sync");
    const path = join(directory, "secrets.dpapi.json");
    if (c.initial) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(path, c.initial);
    }
    const store = await DpapiSecretStore.open(directory, fake);
    if (!store.available()) throw new Error("the fake cipher must pass the self-test");
    const file = () => (existsSync(path) ? readFileSync(path).toString("base64") : null);
    const results: unknown[] = [];
    for (const op of c.ops) {
      switch (op.op) {
        case "read":
          results.push(await store.read(NAME[op.name]));
          break;
        case "write":
          await store.write(NAME[op.name], op.value);
          results.push(file());
          break;
        case "remove":
          await store.remove(NAME[op.name]);
          results.push(file());
          break;
        case "vault-load": {
          const vault = new SecretVault(store);
          await vault.load(op.spaceId);
          results.push({ token: vault.token, secret: vault.secret });
          break;
        }
        case "set-token":
          await new SecretVault(store).setToken(op.token);
          results.push(file());
          break;
        case "set-space":
          await new SecretVault(store).setSpace(op.spaceId, op.secret);
          results.push(file());
          break;
      }
    }
    out.push({
      name: c.name,
      initial: c.initial ? c.initial.toString("base64") : null,
      ops: c.ops,
      results,
    });
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
writeFileSync(join(here, "secret-vectors.json"), `${JSON.stringify({ cases: out }, null, 1)}\n`);
console.log(`${out.length} cases`);

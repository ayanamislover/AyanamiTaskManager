// 应用数据接口的客户端契约：ATM 的同步连接器与手机 App 依赖的全部行为。
//
// 同一套断言既在 vitest 里对 atm-relay 跑（test/contract.test.ts），
// 也能用 scripts/contract-against.ts 对任意兼容服务（例如本地 AyanamiCloud）跑。
// 用例只写「客户端看得到、并且依赖」的东西；服务端实现细节（限流、名额、CORS）不在这里。
import assert from "node:assert/strict";
import {
  type ContractCapabilities,
  ContractClient,
  type ContractTarget,
  newNamespace,
} from "./contract-client.js";

export { ContractClient, newNamespace };
export type { ContractCapabilities, ContractTarget };

export type ContractCase = {
  name: string;
  /** 返回跳过原因（字符串）表示本目标不适用；返回 null 表示要跑。 */
  skip?: (capabilities: ContractCapabilities) => string | null;
  run: (client: ContractClient) => Promise<void>;
};

/** RFC 3339 UTC，固定毫秒三位：2026-09-30T12:00:00.000Z。 */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DOCUMENT_FIELDS = [
  "data",
  "key",
  "revision",
  "schema_version",
  "size_bytes",
  "updated_at",
  "updated_by_device",
];
const META_FIELDS = DOCUMENT_FIELDS.filter((field) => field !== "data");
const CHANGE_FIELDS = ["at", "device_id", "key", "op", "revision", "seq"];

function expectError(response: { status: number; json: any }, status: number, code: string) {
  assert.equal(response.status, status, `期望 HTTP ${status}，实际 ${response.status}`);
  assert.equal(typeof response.json?.error, "object", "错误体应为 {error:{…}}");
  assert.equal(response.json.error.code, code);
  assert.equal(typeof response.json.error.message, "string");
  assert.ok(response.json.error.message.length > 0, "错误信息不能为空");
}

function expectDocument(doc: any, key: string, data: unknown) {
  assert.deepEqual(Object.keys(doc).sort(), DOCUMENT_FIELDS);
  assert.equal(doc.key, key);
  assert.ok(Number.isInteger(doc.revision) && doc.revision >= 1, "revision 应为正整数");
  assert.ok(Number.isInteger(doc.schema_version), "schema_version 应为整数");
  assert.match(doc.updated_at, ISO_UTC);
  assert.ok(doc.updated_by_device === null || typeof doc.updated_by_device === "string");
  assert.equal(doc.size_bytes, Buffer.byteLength(JSON.stringify(data), "utf8"));
  assert.deepEqual(doc.data, data);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const appDataContractCases: ContractCase[] = [
  {
    name: "GET /v1/apps/{app}：200 且 id 等于 app，能力声明与实际一致",
    async run(client) {
      const response = await client.request("GET", client.appPath());
      assert.equal(response.status, 200);
      const app = response.json;
      assert.equal(app.id, client.target.appId);
      assert.equal(typeof app.name, "string");
      assert.ok(["connected", "pending", "disabled"].includes(app.status));
      assert.equal(typeof app.created_at, "string");
      assert.ok(Number.isInteger(app.document_count));
      assert.ok(Array.isArray(app.shared_documents));
      if (client.target.capabilities.longPoll) {
        assert.equal(app.relay?.long_poll, true);
        assert.ok(Number.isInteger(app.relay.max_wait) && app.relay.max_wait >= 1);
      } else {
        assert.notEqual(app.relay?.long_poll, true, "服务端声明了长轮询，但目标按不支持配置");
      }
    },
  },
  {
    name: "没有 token 或 token 无效：401 UNAUTHORIZED；Bearer 方案名大小写不敏感",
    async run(client) {
      const lower = await client.request("GET", client.appPath(), {
        authorization: `bearer ${client.target.token}`,
      });
      assert.equal(lower.status, 200);
      expectError(
        await client.request("GET", client.appPath(), { token: null }),
        401,
        "UNAUTHORIZED",
      );
      const bogus = `${client.target.token.slice(0, 4)}zzzzzzzz_notarealtokennotarealtoken00`;
      expectError(
        await client.request("GET", client.appPath(), { token: bogus }),
        401,
        "UNAUTHORIZED",
      );
    },
  },
  {
    name: "token 访问别的 app：403 FORBIDDEN",
    async run(client) {
      const other = client.target.appId === "contract-other" ? "contract-other2" : "contract-other";
      const response = await client.request("GET", `/v1/apps/${other}/documents`);
      expectError(response, 403, "FORBIDDEN");
    },
  },
  {
    name: "新建：201 与完整 Document；读回一致；不存在 404 NOT_FOUND",
    async run(client) {
      const key = client.key("create");
      const data = { n: 1, text: "文字 ✓", nested: { list: [1, 2, 3], flag: true, none: null } };
      const created = await client.put(key, 0, data);
      assert.equal(created.status, 201);
      expectDocument(created.json, key, data);
      assert.equal(created.json.schema_version, 1);
      const read = await client.get(key);
      assert.equal(read.status, 200);
      assert.deepEqual(read.json, created.json);
      expectError(await client.get(client.key("missing")), 404, "NOT_FOUND");
    },
  },
  {
    name: "更新：200、修订号 +1；schema_version 取请求值，缺省或 ≤ 0 回到 1",
    async run(client) {
      const key = client.key("update");
      const first = await client.put(key, 0, { v: 1 });
      const r = first.json.revision as number;
      const second = await client.put(key, r, { v: 2 }, { schema_version: 3 });
      assert.equal(second.status, 200);
      expectDocument(second.json, key, { v: 2 });
      assert.equal(second.json.revision, r + 1);
      assert.equal(second.json.schema_version, 3);
      const third = await client.put(key, r + 1, { v: 3 });
      assert.equal(third.status, 200);
      assert.equal(third.json.revision, r + 2);
      assert.equal(third.json.schema_version, 1);
      const zero = await client.put(key, r + 2, { v: 4 }, { schema_version: 0 });
      assert.equal(zero.json.schema_version, 1, "schema_version ≤ 0 按 1 处理");
    },
  },
  {
    name: "修订号不符：409 REVISION_CONFLICT，顶层带 current 与 conflict_id",
    async run(client) {
      const key = client.key("conflict");
      const created = await client.put(key, 0, { owner: "a" });
      const r = created.json.revision as number;
      const stale = await client.put(key, r + 5, { owner: "b" });
      expectError(stale, 409, "REVISION_CONFLICT");
      assert.equal(stale.json.current.revision, r);
      assert.deepEqual(stale.json.current.data, { owner: "a" });
      assert.ok("conflict_id" in stale.json, "PUT 的 409 应带 conflict_id 字段");
      assert.equal(stale.json.conflict_id, null);
      const recreate = await client.put(key, 0, { owner: "c" });
      expectError(recreate, 409, "REVISION_CONFLICT");
      assert.equal(recreate.json.current.revision, r);
      const phantom = await client.put(client.key("conflict-missing"), 3, { x: 1 });
      expectError(phantom, 409, "REVISION_CONFLICT");
      assert.equal(phantom.json.current, null);
      expectError(await client.get(client.key("conflict-missing")), 404, "NOT_FOUND");
    },
  },
  {
    name: "删除：缺参数 400、不符 409 带 current、成功 204、再删 404",
    async run(client) {
      const key = client.key("delete");
      const created = await client.put(key, 0, { d: 1 });
      const r = created.json.revision as number;
      expectError(await client.request("DELETE", client.docPath(key)), 400, "INVALID_ARGUMENT");
      const wrong = await client.remove(key, r + 1);
      expectError(wrong, 409, "REVISION_CONFLICT");
      assert.equal(wrong.json.current.revision, r);
      assert.ok(!("conflict_id" in wrong.json), "DELETE 的 409 不带 conflict_id");
      const removed = await client.remove(key, r);
      assert.equal(removed.status, 204);
      assert.equal(removed.text, "");
      expectError(await client.get(key), 404, "NOT_FOUND");
      expectError(await client.remove(key, r), 404, "NOT_FOUND");
    },
  },
  {
    name: "修订号跨删除单调递增：删除消耗一个修订号，重建大于以前的全部修订号",
    async run(client) {
      const key = client.key("aba");
      const head = await client.headCursor();
      const created = await client.put(key, 0, { gen: 1 });
      const r = created.json.revision as number;
      assert.equal((await client.remove(key, r)).status, 204);
      const again = await client.put(key, 0, { gen: 2 });
      assert.equal(again.status, 201);
      // 客户端只依赖「重建严格大于删除用掉的修订号」。AyanamiCloud 恰好是 r + 2；
      // atm-relay 取应用的修订号地板 + 1，应用里同时有别的删除时会更大（README「兼容性」）。
      const rebuilt = again.json.revision as number;
      assert.ok(rebuilt > r + 1, `重建的修订号 ${rebuilt} 应大于删除用掉的 ${r + 1}`);
      for (const stale of [r, r + 1]) {
        expectError(await client.put(key, stale, { gen: 3 }), 409, "REVISION_CONFLICT");
      }
      const ours = (await client.changesSince(head)).changes.filter((c) => c.key === key);
      assert.deepEqual(
        ours.map((c) => [c.op, c.revision]),
        [
          ["put", r],
          ["delete", r + 1],
          ["put", rebuilt],
        ],
      );
    },
  },
  {
    name: "键里的斜杠编码为 %2F；未编码的斜杠不是合法路径",
    async run(client) {
      const key = client.key("slash/a/b.c-d_e");
      const created = await client.put(key, 0, { s: 1 });
      assert.equal(created.status, 201);
      assert.equal(created.json.key, key);
      assert.equal((await client.get(key)).json.key, key);
      const listed = await client.request(
        "GET",
        client.appPath(`/documents?prefix=${encodeURIComponent(client.key("slash/"))}`),
      );
      assert.deepEqual(
        listed.json.documents.map((d: any) => d.key),
        [key],
      );
      const raw = await client.request("GET", client.appPath(`/documents/${key}`));
      assert.equal(raw.status, 404, "未编码的斜杠不应被当作键的一部分");
    },
  },
  {
    name: "非法键：400 INVALID_ARGUMENT",
    async run(client) {
      const bad = [
        `${client.namespace}/../x`,
        `${client.namespace}//x`,
        `${client.namespace}/./x`,
        `/${client.namespace}/x`,
        `${client.namespace}/x/`,
        `${client.namespace}/has space`,
        `${client.namespace}/ключ`,
        "x".repeat(201),
      ];
      for (const key of bad) {
        expectError(await client.get(key), 400, "INVALID_ARGUMENT");
        const put = await client.request("PUT", client.docPath(key), {
          body: { expected_revision: 0, data: 1 },
        });
        expectError(put, 400, "INVALID_ARGUMENT");
      }
      assert.equal((await client.put(client.key("x".repeat(160)), 0, 1)).status, 201);
    },
  },
  {
    name: '请求体校验：读不懂 400 BAD_REQUEST（含 "0"、1.0、1e2）；缺字段或负修订号 400 INVALID_ARGUMENT',
    async run(client) {
      const key = client.key("body");
      const path = client.docPath(key);
      expectError(await client.request("PUT", path, { rawBody: "{not json" }), 400, "BAD_REQUEST");
      expectError(await client.request("PUT", path, { rawBody: "[1,2]" }), 400, "BAD_REQUEST");
      const typed = await client.request("PUT", path, {
        body: { expected_revision: "0", data: 1 },
      });
      expectError(typed, 400, "BAD_REQUEST");
      for (const literal of ["1.0", "1e2"]) {
        const rawBody = `{"expected_revision":${literal},"data":1}`;
        expectError(await client.request("PUT", path, { rawBody }), 400, "BAD_REQUEST");
      }
      const cases: unknown[] = [
        { data: 1 },
        { expected_revision: 0 },
        { expected_revision: -1, data: 1 },
      ];
      for (const body of cases) {
        expectError(await client.request("PUT", path, { body }), 400, "INVALID_ARGUMENT");
      }
      expectError(await client.get(key), 404, "NOT_FOUND");
    },
  },
  {
    name: "data 以 256 KiB 为界：恰好 256 KiB 可写，多 1 字节 413 PAYLOAD_TOO_LARGE",
    async run(client) {
      const limit = 256 * 1024;
      const fits = "a".repeat(limit - 2);
      const ok = await client.put(client.key("big-ok"), 0, fits);
      assert.equal(ok.status, 201);
      assert.equal(ok.json.size_bytes, limit);
      const tooBig = await client.put(client.key("big-no"), 0, `${fits}a`);
      expectError(tooBig, 413, "PAYLOAD_TOO_LARGE");
      expectError(await client.get(client.key("big-no")), 404, "NOT_FOUND");
    },
  },
  {
    name: "data 原样保存：大整数、1.0、1e2 不经数值往返；size_bytes 按原文计",
    async run(client) {
      const key = client.key("raw");
      const rawData = '{"big": 12345678901234567890, "f": 1.0, "e": 1e2}';
      const put = await client.request("PUT", client.docPath(key), {
        rawBody: `{"expected_revision":0,"data":${rawData}}`,
      });
      assert.equal(put.status, 201);
      assert.equal(put.json.size_bytes, Buffer.byteLength(rawData));
      const read = await client.get(key);
      assert.match(read.text, /"big":12345678901234567890[,}]/);
      assert.match(read.text, /"f":1\.0[,}]/);
      assert.match(read.text, /"e":1e2[,}]/);
    },
  },
  {
    name: "列表：prefix 过滤、按键排序、不含 data、limit 与 next_cursor 翻页",
    async run(client) {
      const names = ["k3", "k0", "k4", "k1", "k2"];
      for (const name of names) await client.put(client.key(`list/${name}`), 0, { name });
      await client.put(client.key("listing-outside"), 0, { outside: true });
      const prefix = encodeURIComponent(client.key("list/"));
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const query: string = `prefix=${prefix}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const response = await client.request("GET", client.appPath(`/documents?${query}`));
        assert.equal(response.status, 200);
        assert.deepEqual(Object.keys(response.json).sort(), ["documents", "next_cursor"]);
        assert.ok(response.json.documents.length <= 2);
        for (const doc of response.json.documents) {
          assert.deepEqual(Object.keys(doc).sort(), META_FIELDS);
          seen.push(doc.key);
        }
        cursor = response.json.next_cursor;
        if (cursor === null) break;
        assert.equal(typeof cursor, "string");
      }
      assert.deepEqual(
        seen,
        ["k0", "k1", "k2", "k3", "k4"].map((name) => client.key(`list/${name}`)),
      );
      for (const limit of ["0", "abc"]) {
        const all = await client.request(
          "GET",
          client.appPath(`/documents?prefix=${prefix}&limit=${limit}`),
        );
        assert.equal(all.json.documents.length, 5, `limit=${limit} 应按默认 100 处理`);
        assert.equal(all.json.next_cursor, null);
      }
    },
  },
  {
    name: "变更流：增量、limit 分页与 has_more、空页回显游标、device_id 记录",
    async run(client) {
      const head = await client.headCursor();
      const a = client.key("feed/a");
      const b = client.key("feed/b");
      const createdA = await client.put(a, 0, { a: 1 }, { device_id: "contract-dev-1" });
      assert.equal(createdA.json.updated_by_device, "contract-dev-1");
      await client.put(b, 0, { b: 1 });
      assert.equal((await client.remove(a, createdA.json.revision)).status, 204);

      const first = await client.changes(head, "limit=2");
      assert.equal(first.status, 200);
      assert.deepEqual(Object.keys(first.json).sort(), ["changes", "has_more", "next_cursor"]);
      assert.equal(first.json.changes.length, 2);
      assert.equal(first.json.has_more, true);
      assert.equal(typeof first.json.next_cursor, "string");

      const { changes, cursor } = await client.changesSince(head);
      const ours = changes.filter((c) => c.key === a || c.key === b);
      for (const change of changes) {
        assert.deepEqual(Object.keys(change).sort(), CHANGE_FIELDS);
        assert.match(change.at, ISO_UTC);
      }
      const seqs = changes.map((c) => c.seq as number);
      assert.deepEqual(
        seqs,
        [...seqs].sort((x, y) => x - y),
        "seq 应严格递增",
      );
      assert.equal(new Set(seqs).size, seqs.length);
      assert.deepEqual(
        ours.map((c) => [c.key, c.op, c.device_id]),
        [
          [a, "put", "contract-dev-1"],
          [b, "put", null],
          [a, "delete", null],
        ],
      );
      const empty = await client.changes(cursor);
      assert.equal(empty.status, 200);
      assert.deepEqual(empty.json.changes, []);
      assert.equal(empty.json.has_more, false);
      assert.equal(empty.json.next_cursor, cursor);
    },
  },
  {
    name: "游标不合法：400 INVALID_ARGUMENT",
    async run(client) {
      expectError(await client.changes("!!!"), 400, "INVALID_ARGUMENT");
      const docs = await client.request("GET", client.appPath("/documents?cursor=!!!"));
      expectError(docs, 400, "INVALID_ARGUMENT");
    },
  },
  {
    name: "未知接口：404 JSON 错误体",
    async run(client) {
      expectError(
        await client.request("GET", client.appPath("/no-such-endpoint")),
        404,
        "NOT_FOUND",
      );
    },
  },
  {
    name: "长轮询：没有新变更时挂起到 wait 超时，返回空页与原游标",
    skip: (capabilities) => (capabilities.longPoll ? null : "服务端不支持长轮询"),
    async run(client) {
      await client.put(client.key("poll/seed"), 0, 1);
      const head = await client.headCursor();
      const response = await client.changes(head, "wait=2");
      assert.equal(response.status, 200);
      assert.deepEqual(response.json.changes, []);
      assert.equal(response.json.next_cursor, head);
      assert.ok(
        response.elapsedMs >= 1500,
        `应挂起约 2 秒，实际 ${Math.round(response.elapsedMs)}ms`,
      );
    },
  },
  {
    name: "长轮询：写入立即唤醒挂起的请求",
    skip: (capabilities) => (capabilities.longPoll ? null : "服务端不支持长轮询"),
    async run(client) {
      await client.put(client.key("poll/seed2"), 0, 1);
      const head = await client.headCursor();
      const key = client.key("poll/wake");
      const pending = client.changes(head, "wait=20");
      await sleep(300);
      await client.put(key, 0, { woke: true });
      const response = await pending;
      assert.equal(response.status, 200);
      assert.ok(
        response.elapsedMs < 5000,
        `应被写入唤醒，实际等了 ${Math.round(response.elapsedMs)}ms`,
      );
      assert.ok(response.json.changes.some((c: any) => c.key === key));
    },
  },
  {
    name: "不支持长轮询的服务忽略 wait、立即返回",
    skip: (capabilities) => (capabilities.longPoll ? "服务端支持长轮询" : null),
    async run(client) {
      const head = await client.headCursor();
      const response = await client.changes(head, "wait=5");
      assert.equal(response.status, 200);
      assert.ok(response.elapsedMs < 2500, `应立即返回，实际 ${Math.round(response.elapsedMs)}ms`);
    },
  },
  {
    name: "游标之后的变更被裁剪：410 CURSOR_EXPIRED，从空游标重来可恢复",
    skip: (capabilities) =>
      capabilities.changeRetention ? null : "未给出变更保留条数（要写 retention+2 次）",
    async run(client) {
      const key = client.key("retention");
      let doc = await client.put(key, 0, { i: 0 });
      const stale = await client.headCursor();
      assert.notEqual(stale, null);
      const writes = (client.target.capabilities.changeRetention ?? 0) + 2;
      for (let i = 1; i <= writes; i++) doc = await client.put(key, doc.json.revision, { i });
      expectError(await client.changes(stale), 410, "CURSOR_EXPIRED");
      const fresh = await client.changes(null, "limit=1");
      assert.equal(fresh.status, 200);
    },
  },
];

export type CaseOutcome = {
  name: string;
  status: "passed" | "failed" | "skipped";
  detail?: string;
};

/** 独立运行（不依赖 vitest）：逐条执行并回调结果，结束后清理命名空间。 */
export async function runAppDataContract(
  target: ContractTarget,
  report: (outcome: CaseOutcome) => void,
): Promise<CaseOutcome[]> {
  const client = new ContractClient(target, newNamespace());
  const outcomes: CaseOutcome[] = [];
  try {
    for (const contractCase of appDataContractCases) {
      const reason = contractCase.skip?.(target.capabilities) ?? null;
      let outcome: CaseOutcome;
      if (reason !== null) {
        outcome = { name: contractCase.name, status: "skipped", detail: reason };
      } else {
        try {
          await contractCase.run(client);
          outcome = { name: contractCase.name, status: "passed" };
        } catch (error) {
          outcome = { name: contractCase.name, status: "failed", detail: (error as Error).message };
        }
      }
      outcomes.push(outcome);
      report(outcome);
    }
  } finally {
    await client.cleanup();
  }
  return outcomes;
}

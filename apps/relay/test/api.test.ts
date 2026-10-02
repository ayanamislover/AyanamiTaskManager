// atm-relay 自身的接口行为：契约之外的扩展与安全边界（认证、归属、CORS、日志、持久化）。
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/commands.js";
import { createApp, createToken, hashToken } from "../src/tokens.js";
import {
  call,
  capturingLogger,
  cleanupHarness,
  startTestRelay,
  tempDataDir,
} from "./support/relay-harness.js";

afterEach(cleanupHarness);

const doc = (key: string) => `/v1/apps/atm/documents/${encodeURIComponent(key)}`;

describe("路由、方法与 CORS", () => {
  it("/health/live 不需要 token；未知路径 404；已知路径用错方法 405 并列出可用方法", async () => {
    const relay = await startTestRelay();
    const health = await call(relay.baseUrl, "GET", "/health/live");
    expect(health.status).toBe(200);
    expect(health.json).toEqual({ ok: true });

    const missing = await call(relay, "GET", "/v1/nothing");
    expect(missing.status).toBe(404);
    expect(missing.json.error.code).toBe("NOT_FOUND");

    const wrong = await call(relay, "POST", "/v1/apps/atm/changes");
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("GET");
    expect(wrong.json.error.code).toBe("METHOD_NOT_ALLOWED");

    const badEscape = await call(relay, "GET", "/v1/apps/atm/documents/a%ZZb");
    expect(badEscape.status).toBe(400);
    expect(badEscape.json.error.code).toBe("BAD_REQUEST");
  });

  it("预检放行 Authorization 与 Content-Type；普通响应带 Access-Control-Allow-Origin: *，不放 Cookie", async () => {
    const relay = await startTestRelay();
    const preflight = await call(relay.baseUrl, "OPTIONS", "/v1/apps/atm/changes", {
      headers: {
        Origin: "https://app.example.com",
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-headers")).toMatch(/Authorization/);
    expect(preflight.headers.get("access-control-allow-headers")).toMatch(/Content-Type/);
    expect(preflight.headers.get("access-control-allow-methods")).toMatch(/PUT/);
    expect(preflight.headers.get("access-control-allow-methods")).toMatch(/DELETE/);
    expect(preflight.headers.get("access-control-allow-credentials")).toBeNull();

    const normal = await call(relay, "GET", "/v1/apps/atm", {
      headers: { Origin: "https://app.example.com" },
    });
    expect(normal.headers.get("access-control-allow-origin")).toBe("*");
    expect(normal.headers.get("access-control-expose-headers")).toMatch(/Retry-After/);
    expect(normal.headers.get("cache-control")).toBe("no-store");
  });
});

describe("认证与归属", () => {
  it("有效 token 访问别的 app 是 403；app 不存在同样 403，不泄露存在性", async () => {
    const relay = await startTestRelay();
    createApp(relay.relay.db, "other", "别的应用");
    const otherToken = createToken(relay.relay.db, "other", "另一枚").plaintext;

    const cross = await call(relay, "GET", "/v1/apps/atm/documents", { token: otherToken });
    expect(cross.status).toBe(403);
    expect(cross.json.error.code).toBe("FORBIDDEN");
    const ghost = await call(relay, "GET", "/v1/apps/ghost/documents");
    expect(ghost.status).toBe(403);

    const own = await call(relay, "GET", "/v1/apps/other", { token: otherToken });
    expect(own.status).toBe(200);
    expect(own.json.id).toBe("other");
  });

  it("另一个进程里 token revoke 之后下一次请求立即 401", async () => {
    const relay = await startTestRelay();
    expect((await call(relay, "GET", "/v1/apps/atm")).status).toBe(200);
    const listed: string[] = [];
    const io = { stdout: (t: string) => listed.push(t), stderr: () => {}, env: {} };
    await runCli(["token", "list", "--json", "--data", relay.dataDir], io);
    const [initial] = JSON.parse(listed.join("")) as { id: string }[];
    expect(await runCli(["token", "revoke", initial!.id, "--data", relay.dataDir], io)).toBe(0);

    const after = await call(relay, "GET", "/v1/apps/atm");
    expect(after.status).toBe(401);
    expect(after.json.error.code).toBe("UNAUTHORIZED");
  });

  it("Authorization 头大小写不敏感；非 Bearer 方案一律 401", async () => {
    const relay = await startTestRelay();
    const lower = await call(relay.baseUrl, "GET", "/v1/apps/atm", {
      headers: { Authorization: `bearer ${relay.token}` },
    });
    expect(lower.status).toBe(200);
    const basic = await call(relay.baseUrl, "GET", "/v1/apps/atm", {
      headers: { Authorization: `Basic ${Buffer.from(`x:${relay.token}`).toString("base64")}` },
    });
    expect(basic.status).toBe(401);
  });
});

describe("应用详情", () => {
  it("字段与 AyanamiCloud 的 AppDetail 一致，另带 relay 能力声明；不含任何 token 明文或哈希", async () => {
    const relay = await startTestRelay({ limits: { maxWaitSeconds: 20 } });
    await call(relay, "PUT", doc("shared/one"), { body: { expected_revision: 0, data: 1 } });
    await call(relay, "PUT", doc("devices/dev_a/prefs"), {
      body: { expected_revision: 0, data: 2 },
    });
    const response = await call(relay, "GET", "/v1/apps/atm");
    expect(response.status).toBe(200);
    expect(Object.keys(response.json).sort()).toEqual(
      [
        "conflict_count",
        "created_at",
        "description",
        "device_count",
        "device_document_counts",
        "devices",
        "document_count",
        "id",
        "last_sync_at",
        "name",
        "relay",
        "shared_documents",
        "status",
        "storage_bytes",
        "tokens",
      ].sort(),
    );
    expect(response.json.relay).toEqual({
      name: "atm-relay",
      version: "1.0.0",
      long_poll: true,
      max_wait: 20,
    });
    expect(response.json.status).toBe("connected");
    expect(response.json.document_count).toBe(2);
    expect(response.json.shared_documents.map((d: { key: string }) => d.key)).toEqual([
      "shared/one",
    ]);
    expect(response.json.device_document_counts).toEqual({ dev_a: 1 });
    expect(Object.keys(response.json.tokens[0]).sort()).toEqual(
      ["created_at", "device_id", "id", "label", "last_used_at", "prefix", "revoked_at"].sort(),
    );
    expect(response.text).not.toContain(relay.token);
    expect(response.text).not.toContain(relay.token.split("_")[2]!);
    expect(response.text).not.toContain(hashToken(relay.token));
  });
});

describe("请求体与存储细节", () => {
  it("非法 UTF-8、带 BOM 的体 400；重复键取最后一个；device_id 只收可见 ASCII", async () => {
    const relay = await startTestRelay();
    const invalid = Buffer.from([
      ...Buffer.from('{"expected_revision":0,"data":"'),
      0xff,
      0x22,
      0x7d,
    ]);
    const bad = await call(relay, "PUT", doc("u"), { rawBody: invalid });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("BAD_REQUEST");
    const bom = await call(relay, "PUT", doc("u"), {
      rawBody: Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('{"expected_revision":0,"data":1}'),
      ]),
    });
    expect(bom.status).toBe(400);

    const dup = await call(relay, "PUT", doc("dup"), {
      rawBody: '{"expected_revision":0,"data":1,"data":{"last":true}}',
    });
    expect(dup.status).toBe(201);
    expect(dup.json.data).toEqual({ last: true });

    for (const deviceId of ["has space", "x".repeat(129), "tab\there"]) {
      const response = await call(relay, "PUT", doc("dev"), {
        body: { expected_revision: 0, data: 1, device_id: deviceId },
      });
      expect(response.status).toBe(400);
      expect(response.json.error.code).toBe("INVALID_ARGUMENT");
    }
    const typed = await call(relay, "PUT", doc("dev"), {
      body: { expected_revision: 0, data: 1, device_id: 7 },
    });
    expect(typed.json.error.code).toBe("BAD_REQUEST");
  });

  it("修订号地板跨进程重启保留：删除后重启再建，仍是 r+2", async () => {
    const dataDir = tempDataDir();
    const first = await startTestRelay({ dataDir });
    const created = await call(first, "PUT", doc("aba"), {
      body: { expected_revision: 0, data: 1 },
    });
    await call(first, "DELETE", `${doc("aba")}?expected_revision=${created.json.revision}`);
    await first.stop();

    const second = await startTestRelay({ dataDir });
    const again = await call(second, "PUT", doc("aba"), {
      body: { expected_revision: 0, data: 2 },
    });
    expect(again.status).toBe(201);
    expect(again.json.revision).toBe(created.json.revision + 2);
  });

  it("来自未来的游标（比全库最大 seq 还大）返回 410，而不是永远等不到的空页", async () => {
    const relay = await startTestRelay();
    await call(relay, "PUT", doc("x"), { body: { expected_revision: 0, data: 1 } });
    const future = await call(
      relay,
      "GET",
      `/v1/apps/atm/changes?cursor=${(999_999).toString(36)}`,
    );
    expect(future.status).toBe(410);
    expect(future.json.error.code).toBe("CURSOR_EXPIRED");
  });

  it("按时间裁剪：30 天前的变更被删，停在那里的游标 410；最新一条保留", async () => {
    let clock = Date.parse("2026-01-01T00:00:00.000Z");
    const relay = await startTestRelay({ now: () => clock });
    await call(relay, "PUT", doc("t1"), { body: { expected_revision: 0, data: 1 } });
    const head = (await call(relay, "GET", "/v1/apps/atm/changes")).json.next_cursor as string;
    await call(relay, "PUT", doc("t2"), { body: { expected_revision: 0, data: 1 } });
    clock += 31 * 24 * 3600 * 1000;
    await call(relay, "PUT", doc("t3"), { body: { expected_revision: 0, data: 1 } });

    const stale = await call(relay, "GET", `/v1/apps/atm/changes?cursor=${head}`);
    expect(stale.status).toBe(410);
    const all = await call(relay, "GET", "/v1/apps/atm/changes");
    expect(all.json.changes.map((c: { key: string }) => c.key)).toEqual(["t3"]);
  });
});

describe("日志", () => {
  it("访问日志与启动日志里没有 token 明文、token 哈希和文档内容", async () => {
    const capture = capturingLogger();
    const relay = await startTestRelay({ log: capture.log, accessLog: true });
    const secret = "SECRET-PAYLOAD-7f3a";
    await call(relay, "PUT", doc("logged"), { body: { expected_revision: 0, data: { secret } } });
    await call(relay, "GET", doc("logged"));
    await call(relay, "GET", "/v1/apps/atm", { token: `${relay.token}x` });
    await relay.stop();
    const text = capture.text();
    expect(text).toContain("PUT /v1/apps/atm/documents/logged 201");
    expect(text).toContain("initial-token.txt");
    expect(text).not.toContain(relay.token.split("_")[2]!);
    expect(text).not.toContain(hashToken(relay.token));
    expect(text).not.toContain(secret);
  });
});

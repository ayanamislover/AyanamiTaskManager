import { afterEach, describe, expect, it } from "vitest";
import type { FetchLike, FetchLikeResponse } from "@ayanami-task/sync-protocol";
import { REDACTED, redactSecrets, redactingLogger } from "../src/errors.js";
import { SECRET_NAMES, type SecretStore, type SyncLogger } from "../src/index.js";
import { RELAY_URL, cleanupFixtures, connect, openFixture, waitFor } from "./support/fixture.js";
import type { MemoryRelay } from "./support/memory-relay.js";

// peer R1-01：中继看得到 Authorization。它回 4xx/5xx、把收到的 token 写进 error.code 或 error.message
// （或干脆是非 JSON 正文）时，token 不能出现在 status().lastError（Agent 令牌可读）、宿主日志
// 和设置页「测试连接」的结果里。

afterEach(cleanupFixtures);

type Reply = (auth: string) => FetchLikeResponse;

function reply(status: number, text: string): FetchLikeResponse {
  return { status, headers: { get: () => null }, text: async () => text };
}

function json(status: number, body: unknown): FetchLikeResponse {
  return reply(status, JSON.stringify(body));
}

/** 正常时转给内存中继；`hostile` 设上之后每个请求都按它回，并把 Authorization 交给它反射。 */
function hostileRelay(relay: MemoryRelay) {
  const state: { hostile: Reply | null } = { hostile: null };
  const fetchImpl: FetchLike = async (url, init) =>
    state.hostile ? state.hostile(init.headers.Authorization ?? "") : relay.fetch(url, init);
  return { state, fetchImpl };
}

function recordingLogger() {
  const lines: Array<{ level: string; message: string; meta?: Record<string, unknown> }> = [];
  const at =
    (level: string) =>
    (message: string, meta?: Record<string, unknown>): void => {
      lines.push(meta === undefined ? { level, message } : { level, message, meta });
    };
  const logger: SyncLogger = { info: at("info"), warn: at("warn"), error: at("error") };
  return { lines, logger };
}

/** 绕过白名单的唯一办法：读正文时抛一个带 token 的普通错误，用来单独检验纵深防御那一层。 */
const leaky: Reply = (auth) => ({
  status: 500,
  headers: { get: () => null },
  text: async () => {
    throw new Error(`读取正文失败：${auth}`);
  },
});

const CASES: Array<[string, Reply, string]> = [
  [
    "5xx，token 在 error.message",
    (auth) => json(500, { error: { code: "INTERNAL", message: auth } }),
    "中继内部出错（HTTP 500，INTERNAL）",
  ],
  [
    "5xx，token 在 error.code",
    (auth) => json(503, { error: { code: auth, message: "x" } }),
    "中继暂时不可用（HTTP 503）",
  ],
  ["5xx，正文不是 JSON", (auth) => reply(502, `gateway: ${auth}`), "中继暂时不可用（HTTP 502）"],
  [
    "4xx，token 在 error.message",
    (auth) => json(413, { error: { code: "PAYLOAD_TOO_LARGE", message: auth } }),
    "内容超过中继允许的大小（HTTP 413，PAYLOAD_TOO_LARGE）",
  ],
  [
    "4xx，token 在 error.code",
    (auth) => json(400, { error: { code: auth, message: auth } }),
    "中继拒绝了这个请求（HTTP 400）",
  ],
  ["4xx，正文不是 JSON", (auth) => reply(418, auth), "中继拒绝了这个请求（HTTP 418）"],
];

describe("中继错误正文不反射进状态、日志与测试结果", () => {
  it.each(CASES)("同步循环：%s", async (_name, answer, expected) => {
    const fixture = await openFixture();
    try {
      const { state, fetchImpl } = hostileRelay(fixture.relay);
      const { lines, logger } = recordingLogger();
      const connector = fixture.connector({ fetchImpl, logger });
      await connect(connector, fixture.relay);
      state.hostile = answer;
      await waitFor(async () => (await connector.status()).state === "error", "进入 error");
      const status = await connector.status();
      expect(status.lastError).toBe(expected);
      expect(JSON.stringify(status)).not.toContain(fixture.relay.token);
      expect(lines.some((line) => line.message === "同步失败，稍后重试")).toBe(true);
      expect(JSON.stringify(lines)).not.toContain(fixture.relay.token);
    } finally {
      await fixture.close();
    }
  });

  it.each(CASES)("测试连接：%s", async (_name, answer, expected) => {
    const fixture = await openFixture();
    try {
      const { state, fetchImpl } = hostileRelay(fixture.relay);
      state.hostile = answer;
      const connector = fixture.connector({ fetchImpl });
      const candidate = "candidate-token-9e2b41";
      const result = await connector.testRelay({ relayUrl: RELAY_URL, token: candidate });
      expect(result).toMatchObject({ ok: false, error: expected });
      expect(JSON.stringify(result)).not.toContain(candidate);
    } finally {
      await fixture.close();
    }
  });

  it("测试连接：中继自报的名字里带 token 也不原样返回", async () => {
    const fixture = await openFixture();
    try {
      const { state, fetchImpl } = hostileRelay(fixture.relay);
      state.hostile = (auth) =>
        json(200, { id: "atm", relay: { name: auth, version: auth.slice(7), long_poll: true } });
      const connector = fixture.connector({ fetchImpl });
      const candidate = "candidate-token-9e2b41";
      const result = await connector.testRelay({ relayUrl: RELAY_URL, token: candidate });
      expect(result).toMatchObject({ ok: true, longPoll: true });
      expect(JSON.stringify(result)).not.toContain(candidate);
    } finally {
      await fixture.close();
    }
  });

  it("纵深防御：白名单之外漏进来的文字（读正文时抛的错）里的 token 也被抹掉", async () => {
    const fixture = await openFixture();
    try {
      const { state, fetchImpl } = hostileRelay(fixture.relay);
      const { lines, logger } = recordingLogger();
      const connector = fixture.connector({ fetchImpl, logger });
      await connect(connector, fixture.relay);
      state.hostile = leaky;
      await waitFor(async () => (await connector.status()).state === "error", "进入 error");
      const status = await connector.status();
      expect(status.lastError).toBe(`同步出错：读取正文失败：Bearer ${REDACTED}`);
      expect(JSON.stringify(status)).not.toContain(fixture.relay.token);
      expect(JSON.stringify(lines)).toContain(REDACTED);
      expect(JSON.stringify(lines)).not.toContain(fixture.relay.token);

      const result = await connector.testRelay({ relayUrl: RELAY_URL });
      expect(result.error).toBe(`同步出错：读取正文失败：Bearer ${REDACTED}`);
    } finally {
      await fixture.close();
    }
  });

  it("纵深防御：重置配对返回的 cleanupError 里也抹掉 token", async () => {
    const fixture = await openFixture();
    try {
      const { state, fetchImpl } = hostileRelay(fixture.relay);
      const connector = fixture.connector({ fetchImpl });
      await connect(connector, fixture.relay);
      state.hostile = leaky;
      const result = await connector.resetSpace();
      const once = `同步出错：读取正文失败：Bearer ${REDACTED}`;
      // 清空旧空间与写撤销标记两步都失败。
      expect(result.cleanupError).toBe(`${once}；${once}`);
    } finally {
      await fixture.close();
    }
  });

  it("纵深防御：状态出口再抹一遍（不经 describeError 的来源，例如密钥存储的报错）", async () => {
    const fixture = await openFixture();
    try {
      const token = "stored-relay-token-77aa";
      const secrets: SecretStore = {
        kind: "plaintext",
        read: async (name) => {
          if (name === SECRET_NAMES.relayToken) return token;
          throw new Error(`解密失败：${token}`);
        },
        write: async () => undefined,
        remove: async () => undefined,
      };
      const status = await fixture.connector({ secrets }).status();
      expect(status.lastError).toBe(`读取同步密钥失败：解密失败：${REDACTED}`);
    } finally {
      await fixture.close();
    }
  });
});

describe("密钥字面量替换", () => {
  const token = "relay-token-abcdef12";
  const secret = "c2VjcmV0LXNwYWNlLWtleS1mb3ItdGVzdHMtMDEyMzQ1Ng";

  it("替换字面量与 URL 编码形式；空值和太短的值不动", () => {
    const spaced = "token with/slash";
    const text = `a ${token} b ${secret} c ${encodeURIComponent(spaced)} d abc`;
    expect(redactSecrets(text, [token, secret, spaced, null, undefined, "", "abc"])).toBe(
      `a ${REDACTED} b ${REDACTED} c ${REDACTED} d abc`,
    );
  });

  it("日志包装：消息、嵌套 meta、数组和 Error 里的密钥都被抹掉，其余原样", () => {
    const { lines, logger } = recordingLogger();
    const when = new Date(0);
    const wrapped = redactingLogger(logger, () => [token, secret]);
    wrapped.warn(`失败 ${token}`, {
      error: `Bearer ${token}`,
      nested: { secret, list: [token, 3] },
      cause: new Error(`boom ${secret}`),
      when,
      count: 2,
    });
    wrapped.info("没有 meta");
    expect(lines[0]).toEqual({
      level: "warn",
      message: `失败 ${REDACTED}`,
      meta: {
        error: `Bearer ${REDACTED}`,
        nested: { secret: REDACTED, list: [REDACTED, 3] },
        cause: `Error: boom ${REDACTED}`,
        when,
        count: 2,
      },
    });
    expect(lines[1]).toEqual({ level: "info", message: "没有 meta" });
  });

  it("日志包装：太深的结构整体换成占位，非普通对象转成字符串再抹，都不放过密钥", () => {
    const { lines, logger } = recordingLogger();
    const wrapped = redactingLogger(logger, () => [token]);
    let deep: unknown = token;
    for (let level = 0; level < 10; level += 1) deep = { level, inner: deep };
    const shaped = { toString: () => `shaped ${token}` };
    Object.setPrototypeOf(shaped, { kind: "custom" });
    wrapped.error("深层", { deep, shaped });
    expect(JSON.stringify(lines)).not.toContain(token);
    expect(JSON.stringify(lines)).toContain("[…]");
    expect(lines[0]?.meta?.shaped).toBe(`shaped ${REDACTED}`);
  });
});

import { inspect } from "node:util";
import { describe, expect, it } from "vitest";

import { RelayClient, RelayError, type FetchLike, type FetchLikeResponse } from "../src/index.js";

// peer R1-01：中继看得到 Authorization。它把收到的 token 写进错误正文（code 或 message）反射回来时，
// RelayError 不能把这段文字带进任何会被打印、序列化或返回的字段。

const TOKEN = "dummy-review-token-5f3a91";

type Reply = (auth: string) => FetchLikeResponse;

function reply(status: number, text: string, headers: Record<string, string> = {}) {
  const lower = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    status,
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    text: async () => text,
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return reply(status, JSON.stringify(body), headers);
}

/** 恶意中继：每个请求都按 `answer` 回，把请求里的 Authorization 交给它反射。 */
function hostileClient(answer: Reply) {
  const fetchImpl: FetchLike = async (_url, init) => answer(init.headers.Authorization ?? "");
  return new RelayClient({
    baseUrl: "https://relay.example.com",
    appId: "atm",
    token: TOKEN,
    fetchImpl,
  });
}

async function failure(answer: Reply): Promise<RelayError> {
  const error = await hostileClient(answer)
    .changes(null)
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(RelayError);
  return error as RelayError;
}

/** 所有可能被打印、序列化或返回的形态里都不能有 token。 */
function expectNoToken(error: RelayError): void {
  for (const text of [
    error.message,
    error.code,
    String(error),
    error.stack ?? "",
    JSON.stringify(error),
    inspect(error, { depth: 5, showHidden: true }),
  ])
    expect(text).not.toContain(TOKEN);
}

describe("RelayError 不反射中继返回的文本", () => {
  const cases: Array<[string, Reply, { status: number; code: string; message: string }]> = [
    [
      "5xx：token 在 error.message",
      (auth) => json(500, { error: { code: "INTERNAL", message: auth } }),
      { status: 500, code: "INTERNAL", message: "中继内部出错" },
    ],
    [
      "5xx：token 在 error.code",
      (auth) => json(503, { error: { code: auth, message: "x" } }),
      { status: 503, code: "RELAY_ERROR", message: "中继暂时不可用" },
    ],
    [
      "5xx：正文不是 JSON",
      (auth) => reply(502, `upstream said: ${auth}`),
      { status: 502, code: "RELAY_ERROR", message: "中继暂时不可用" },
    ],
    [
      "4xx：token 在 error.message",
      (auth) => json(413, { error: { code: "PAYLOAD_TOO_LARGE", message: auth } }),
      { status: 413, code: "PAYLOAD_TOO_LARGE", message: "内容超过中继允许的大小" },
    ],
    [
      "4xx：token 在 error.code",
      (auth) => json(400, { error: { code: auth, message: "x" } }),
      { status: 400, code: "RELAY_ERROR", message: "中继拒绝了这个请求" },
    ],
    [
      "4xx：正文不是 JSON",
      (auth) => reply(418, auth),
      { status: 418, code: "RELAY_ERROR", message: "中继拒绝了这个请求" },
    ],
    [
      "401：鉴权失败照样标记，但文字是本地的",
      (auth) => json(401, { error: { code: "UNAUTHORIZED", message: `bad ${auth}` } }),
      { status: 401, code: "UNAUTHORIZED", message: "中继不认这个 token（没带、填错或已吊销）" },
    ],
  ];

  it.each(cases)("%s", async (_name, answer, expected) => {
    const error = await failure(answer);
    expect({ status: error.status, code: error.code, message: error.message }).toEqual(expected);
    expectNoToken(error);
  });

  it("白名单码必须配对应的 HTTP 状态；原型链上的名字也不认", async () => {
    const mismatched = await failure(() => json(500, { error: { code: "REVISION_CONFLICT" } }));
    expect(mismatched.code).toBe("RELAY_ERROR");
    for (const code of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const error = await failure(() => json(400, { error: { code } }));
      expect(error.code).toBe("RELAY_ERROR");
      expect(error.message).toBe("中继拒绝了这个请求");
    }
  });

  it("本地构造 HTTP 错误时传进来的文字也不用，code 同样过白名单", () => {
    const error = new RelayError(500, `Bearer ${TOKEN}`, `Bearer ${TOKEN}`);
    expect(error.code).toBe("RELAY_ERROR");
    expect(error.message).toBe("中继暂时不可用");
    expectNoToken(error);
  });

  it("409 的 current 只留数字字段，字符串与 data 都不留", async () => {
    const error = await hostileClient((auth) =>
      json(409, {
        error: { code: "REVISION_CONFLICT", message: auth },
        current: {
          key: auth,
          revision: 7,
          schema_version: 2,
          updated_at: auth,
          updated_by_device: auth,
          size_bytes: 12,
          data: { leak: auth },
        },
      }),
    )
      .putDocument("atm1/k", 3, { x: 1 })
      .catch((caught: unknown) => caught as RelayError);
    expect(error).toBeInstanceOf(RelayError);
    expect(error.code).toBe("REVISION_CONFLICT");
    expect(error.current).toEqual({ revision: 7, schemaVersion: 2, sizeBytes: 12 });
    expectNoToken(error);
  });

  it("409 的 current 修订号不是非负整数就按 0 处理", async () => {
    for (const revision of [-1, 1.5, "7", Number.MAX_SAFE_INTEGER + 2]) {
      const error = await hostileClient(() =>
        json(409, { error: { code: "REVISION_CONFLICT" }, current: { revision } }),
      )
        .putDocument("atm1/k", 3, { x: 1 })
        .catch((caught: unknown) => caught as RelayError);
      expect(error.current?.revision).toBe(0);
    }
  });

  it("等待秒数只认数字：正文 retry_after 是数字，或 Retry-After 头是纯数字", async () => {
    const after = async (answer: Reply) => (await failure(answer)).retryAfter;
    const limited = { code: "RATE_LIMITED" };
    expect(await after(() => json(429, { error: { ...limited, retry_after: 3 } }))).toBe(3);
    expect(await after(() => json(429, { error: limited }, { "Retry-After": " 7 " }))).toBe(7);
    expect(await after(() => json(429, { error: { ...limited, retry_after: "5" } }))).toBeNull();
    expect(
      await after((auth) => json(429, { error: limited }, { "Retry-After": auth })),
    ).toBeNull();
    const date = { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" };
    expect(await after(() => json(429, { error: limited }, date))).toBeNull();
    expect(await after(() => json(429, { error: { ...limited, retry_after: -2 } }))).toBeNull();
    expect(await after(() => json(429, { error: { ...limited, retry_after: 1e9 } }))).toBe(600);
  });
});

describe("本地判定的错误也不带对端可控的文字", () => {
  it("网络层报错的 message 不进 RelayError，只留超时与否和运行时错误码", async () => {
    const thrown = (error: unknown) =>
      failure(() => {
        throw error;
      });
    // 例如 Android 的证书错误会把对方证书的 DN / SAN 写进 message。
    const tls = new Error(`Hostname relay not verified: subjectAltNames: [Bearer ${TOKEN}]`);
    const plain = await thrown(tls);
    expect({ status: plain.status, code: plain.code, message: plain.message }).toEqual({
      status: 0,
      code: "NETWORK",
      message: "连不上中继",
    });
    expectNoToken(plain);

    const refused = await thrown(
      Object.assign(new TypeError(`fetch failed ${TOKEN}`), { cause: { code: "ECONNREFUSED" } }),
    );
    expect(refused.message).toBe("连不上中继（ECONNREFUSED）");
    const odd = await thrown(Object.assign(new Error("x"), { code: `Bearer ${TOKEN}` }));
    expect(odd.message).toBe("连不上中继");
    const timeout = await thrown(new DOMException(`timed out ${TOKEN}`, "TimeoutError"));
    expect(timeout.message).toBe("连接中继超时");
    for (const error of [refused, odd, timeout]) expectNoToken(error);
  });

  it("不合法的文档键不拼进错误文字（键可能来自中继的变更流）", async () => {
    const client = hostileClient(() => json(200, {}));
    const error = await client
      .getDocument(`atm1/Bearer ${TOKEN}`)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 0, code: "KEY_INVALID", message: "文档键不合法" });
    expectNoToken(error as RelayError);
  });

  it("探测结果里中继自报的名字与版本按标签字符集筛过", async () => {
    const probe = await hostileClient((auth) =>
      json(200, { id: "atm", relay: { name: auth, version: `1.0 ${auth}`, long_poll: true } }),
    ).probe();
    expect(probe).toMatchObject({ server: "app-data", version: null, longPoll: true });
    const fine = await hostileClient(() =>
      json(200, { id: "atm", relay: { name: "atm-relay", version: "1.2.0-rc.1" } }),
    ).probe();
    expect(fine).toMatchObject({ server: "atm-relay", version: "1.2.0-rc.1" });
  });
});

import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { agentFetch } from "../../../scripts/agent-fetch.js";

// 3.x 的 Agent HTTP 把带 Sec-Fetch-* / Origin 的请求当浏览器拒掉；脚本以 Agent 身份调服务只能用 agentFetch。
let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

async function serve(): Promise<{ base: string; seen: IncomingHttpHeaders[]; bodies: string[] }> {
  const seen: IncomingHttpHeaders[] = [];
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers);
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      bodies.push(body);
      if (req.url === "/empty") {
        res.writeHead(204).end();
        return;
      }
      res.writeHead(201, { "content-type": "application/json", "x-trace": "a" });
      res.end(JSON.stringify({ method: req.method, body }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  close = () => new Promise((done) => server.close(() => done()));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, bodies };
}

describe("agentFetch", () => {
  it("不带浏览器特征的头；方法、头、body 与响应原样往返", async () => {
    const { base, seen } = await serve();
    const response = await agentFetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ name: "中文" }),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("x-trace")).toBe("a");
    expect(await response.json()).toEqual({ method: "POST", body: '{"name":"中文"}' });
    const headers = seen[0]!;
    expect(headers.authorization).toBe("Bearer t");
    expect(headers.origin).toBeUndefined();
    expect(Object.keys(headers).filter((key) => key.startsWith("sec-fetch-"))).toEqual([]);
  });

  it("204 没有 body 也能返回", async () => {
    const { base } = await serve();
    const response = await agentFetch(`${base}/empty`);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  // 对照：Node 自带的 fetch 确实会带 Sec-Fetch-Mode（否则上面那条测不出什么）。
  it("对照：全局 fetch 带 sec-fetch-mode", async () => {
    const { base, seen } = await serve();
    await (await fetch(`${base}/x`)).text();
    expect(Object.keys(seen[0]!).some((key) => key.startsWith("sec-fetch-"))).toBe(true);
  });

  it("只接受 http", async () => {
    await expect(async () => agentFetch("https://127.0.0.1/x")).rejects.toThrow(
      /AGENT_FETCH_HTTP_ONLY/u,
    );
  });
});

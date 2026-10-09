import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { request as createRequest, type APIRequestContext } from "@playwright/test";

// 3.0（W5d）：用例里的 Agent 照真实 Agent 的做法找服务——读 N\runtime\daemon.json 里的端点与令牌
// （atm-mcp 桥读的也是它），走真实的 Agent HTTP。界面走 4394 的 ui-bridge，两者不是同一个入口。
const descriptor = resolve(process.cwd(), "output", "e2e", "data", "v3", "runtime", "daemon.json");

type Descriptor = { endpoint: string; token: string };

export function agentEndpoint(): Descriptor {
  const parsed = JSON.parse(readFileSync(descriptor, "utf8")) as Partial<Descriptor>;
  if (typeof parsed.endpoint !== "string" || typeof parsed.token !== "string")
    throw new Error("E2E_DAEMON_JSON_INCOMPLETE");
  return { endpoint: parsed.endpoint, token: parsed.token };
}

/** Agent 的 API 上下文：`${agentApi()}/…` 是 Agent HTTP 上的路径。 */
export function agentApi(): string {
  return `${agentEndpoint().endpoint}/api/v1`;
}

export async function agentContext(): Promise<APIRequestContext> {
  const { token } = agentEndpoint();
  return createRequest.newContext({
    extraHTTPHeaders: {
      authorization: `Bearer ${token}`,
      // Agent HTTP 的 POST 一律要 JSON（没有 body 的也是）。
      "content-type": "application/json",
    },
  });
}

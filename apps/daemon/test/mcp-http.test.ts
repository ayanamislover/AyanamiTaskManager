import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "@ayanami-task/application";
import { buildAyanamiServer } from "../src/index.js";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

describe("Streamable HTTP MCP", () => {
  it("只允许带本地令牌的 MCP 初始化请求", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "atm-mcp-http-"));
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: join(process.cwd(), "migrations"),
    });
    const app = await buildAyanamiServer({ service, token: "local-test-token" });
    cleanup.push(async () => {
      await app.close();
      service.close();
      await rm(dataDir, { recursive: true, force: true });
    });
    const payload = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "http-test", version: "1.0.0" },
      },
    };

    const denied = await app.inject({ method: "POST", url: "/mcp", payload });
    expect(denied.statusCode).toBe(401);

    const accepted = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: "Bearer local-test-token",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload,
    });
    expect(accepted.statusCode).toBe(200);
    const body = accepted.headers["content-type"]?.includes("text/event-stream")
      ? JSON.parse(
          accepted.body
            .split(/\r?\n/u)
            .find((line) => line.startsWith("data:"))!
            .slice(5)
            .trim(),
        )
      : accepted.json();
    expect(body).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: { name: "ayanami-task-manager", version: "1.0.12" } },
    });
  });
});

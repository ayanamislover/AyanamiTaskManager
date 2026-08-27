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
      result: { serverInfo: { name: "ayanami-task-manager", version: "1.0.18" } },
    });
    expect(body.result.instructions).toContain("legacy 兼容入口");
    expect(body.result.instructions).toContain("重启 Agent 客户端");
  });

  it("暴露固定 core / memory / actions Profile，旧入口保留完整兼容能力", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "atm-mcp-profiles-"));
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
    const payload = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
    const list = async (url: string): Promise<string[]> => {
      const response = await app.inject({
        method: "POST",
        url,
        headers: {
          authorization: "Bearer local-test-token",
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        payload,
      });
      expect(response.statusCode).toBe(200);
      const body = response.headers["content-type"]?.includes("text/event-stream")
        ? JSON.parse(
            response.body
              .split(/\r?\n/u)
              .find((line) => line.startsWith("data:"))!
              .slice(5)
              .trim(),
          )
        : response.json();
      return (body.result.tools as Array<{ name: string }>).map((tool) => tool.name);
    };

    const core = await list("/mcp/core");
    const memory = await list("/mcp/memory");
    const actions = await list("/mcp/actions");
    const compatibility = await list("/mcp");

    expect(core).toEqual([
      "atm_begin",
      "atm_brief",
      "atm_task_list",
      "atm_task_get",
      "atm_task_create",
      "atm_end",
    ]);
    expect(memory).toEqual(["atm_progress_add", "atm_record", "atm_search", "atm_delta"]);
    expect(actions).toEqual(["atm_task_patch"]);
    expect(new Set(compatibility)).toEqual(new Set([...core, ...memory, ...actions]));
    expect(compatibility).toHaveLength(11);
    expect(core.filter((name) => memory.includes(name))).toEqual([]);
    expect(actions.filter((name) => [...core, ...memory].includes(name))).toEqual([]);
  });

  it("core 创建的任务可由 actions 修改，三个 Profile 共享同一状态", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "atm-mcp-shared-state-"));
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: join(process.cwd(), "migrations"),
    });
    const project = await service.createProject({
      name: "MCP 双 Profile 共享状态",
      sourcePath: null,
      code: "DMP",
    });
    const app = await buildAyanamiServer({ service, token: "local-test-token" });
    cleanup.push(async () => {
      await app.close();
      service.close();
      await rm(dataDir, { recursive: true, force: true });
    });
    let id = 10;
    const call = async (
      url: "/mcp/core" | "/mcp/memory" | "/mcp/actions",
      name: string,
      args: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => {
      const response = await app.inject({
        method: "POST",
        url,
        headers: {
          authorization: "Bearer local-test-token",
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        payload: {
          jsonrpc: "2.0",
          id: id++,
          method: "tools/call",
          params: { name, arguments: args },
        },
      });
      expect(response.statusCode).toBe(200);
      const body = response.headers["content-type"]?.includes("text/event-stream")
        ? JSON.parse(
            response.body
              .split(/\r?\n/u)
              .find((line) => line.startsWith("data:"))!
              .slice(5)
              .trim(),
          )
        : response.json();
      expect(body.error).toBeUndefined();
      return body.result.structuredContent as Record<string, unknown>;
    };

    const begun = await call("/mcp/core", "atm_begin", {
      op_id: "dual-profile-shared-begin",
      project_code: project.code,
      mode: "project",
      agent_id: "dual-profile-test",
    });
    const session = String(begun.session);
    const created = await call("/mcp/core", "atm_task_create", {
      project: project.code,
      session,
      op_id: "dual-profile-shared-create",
      items: [{ client_ref: "shared", title: "共享任务", status: "READY" }],
    });
    const task = (
      created.entities as Array<{ entity_type: string; key: string; version: number | null }>
    ).find((entity) => entity.entity_type === "WORK_ITEM");
    if (!task || task.version === null) throw new Error("WORK_ITEM_MUTATION_ENTITY_MISSING");

    await call("/mcp/actions", "atm_task_patch", {
      project: project.code,
      session,
      op_id: "dual-profile-shared-claim",
      items: [{ task_key: task.key, expected_version: task.version, operation: "claim" }],
    });

    const readBack = await call("/mcp/core", "atm_task_get", {
      project: project.code,
      task_key: task.key,
      view: "core",
    });
    expect(readBack).toMatchObject({ key: task.key, status: "CLAIMED" });
  });
});

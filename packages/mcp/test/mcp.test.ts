import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AyanamiTaskService } from "@ayanami-task/application";
import { createAyanamiMcpServer } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("Ayanami MCP", () => {
  it("公开恰好 11 个紧凑工具，并让 begin 同时返回结构化与单行结果", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "atm-mcp-"));
    roots.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: join(process.cwd(), "migrations"),
    });
    const project = await service.createProject({
      name: "MCP 验收项目",
      sourcePath: null,
      code: "MCP",
    });
    const server = createAyanamiMcpServer(service);
    const client = new Client({ name: "mcp-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "atm_begin",
      "atm_brief",
      "atm_task_list",
      "atm_task_get",
      "atm_task_create",
      "atm_task_patch",
      "atm_progress_add",
      "atm_record",
      "atm_search",
      "atm_delta",
      "atm_end",
    ]);
    expect(listed.tools.every((tool) => tool.outputSchema)).toBe(true);
    expect(JSON.stringify(listed.tools).length).toBeLessThanOrEqual(8_000);

    const result = await client.callTool({
      name: "atm_begin",
      arguments: {
        project_code: project.code,
        mode: "project",
        agent_id: "codex",
      },
    });
    expect(result.structuredContent).toMatchObject({ scope: "project", project: "MCP" });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).not.toContain("\n");
    expect(text.length).toBeLessThanOrEqual(1200);

    const firstSession = String((result.structuredContent as Record<string, unknown>).session);
    const projectProgress = await client.callTool({
      name: "atm_progress_add",
      arguments: {
        project: "MCP",
        session: firstSession,
        op_id: "project-progress-1",
        scope: "project",
        summary: "完成 MCP 恢复协议",
        health: "ON_TRACK",
        completed: [],
        next: ["继续烟测"],
        evidence: [],
      },
    });
    expect(projectProgress.structuredContent).toMatchObject({ ok: true, health: "ON_TRACK" });
    const retired = await client.callTool({
      name: "atm_end",
      arguments: {
        project: "MCP",
        session: firstSession,
        op_id: "retire-1",
        outcome: "retired",
        summary: "轮换上下文",
        next: ["继续烟测"],
        release_claims: true,
      },
    });
    expect(retired.structuredContent).toMatchObject({ ok: true, handoffs: 0 });
    const resumed = await client.callTool({
      name: "atm_begin",
      arguments: {
        project_code: "MCP",
        mode: "project",
        agent_id: "codex",
        resume: true,
        predecessor_session_id: firstSession,
      },
    });
    expect(resumed.structuredContent).toMatchObject({
      scope: "project",
      project: "MCP",
      truncated: false,
    });
    expect((resumed.content[0] as { text: string }).text.length).toBeLessThanOrEqual(1200);

    await Promise.all([client.close(), server.close()]);
    service.close();
  });
});

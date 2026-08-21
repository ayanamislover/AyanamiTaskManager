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
  it("公开恰好 12 个紧凑工具，并让 begin 同时返回结构化与单行结果", async () => {
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
      "atm_checklist",
      "atm_progress_add",
      "atm_record",
      "atm_search",
      "atm_delta",
      "atm_end",
    ]);
    expect(listed.tools.every((tool) => tool.outputSchema)).toBe(true);
    // 预算是 docs/release-checklist.md 写的 8 KB，即 8192 字节；此处原本钉的是更严的
    // 8_000，第 12 个工具 atm_checklist（471 字节）放不下。对齐到文档说的那个数，
    // 而不是改字段名去凑——但要清楚：这确实吃掉了原先 192 字节的余量。
    expect(JSON.stringify(listed.tools).length).toBeLessThanOrEqual(8_192);
    expect(listed.tools.find((tool) => tool.name === "atm_begin")?.description).toContain(
      "直接使用返回的 brief",
    );
    expect(listed.tools.find((tool) => tool.name === "atm_brief")?.description).toContain(
      "仅在上下文压缩、长时间离开或明确恢复 working set",
    );
    expect(
      JSON.stringify(listed.tools.find((tool) => tool.name === "atm_task_create")?.inputSchema),
    ).toContain("discovered_from");

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
        summary: "进".repeat(300),
        health: "ON_TRACK",
        completed: [],
        next: ["继续烟测"],
        evidence: [],
      },
    });
    expect(projectProgress.structuredContent).toMatchObject({ ok: true, health: "ON_TRACK" });
    const boundaryProgress = await client.callTool({
      name: "atm_progress_add",
      arguments: {
        project: "MCP",
        session: firstSession,
        op_id: "project-progress-500",
        scope: "project",
        summary: "界".repeat(500),
        completed: [],
        next: [],
        evidence: [],
      },
    });
    expect(boundaryProgress.structuredContent).toMatchObject({ ok: true });
    const rejectedProgress = await client.callTool({
      name: "atm_progress_add",
      arguments: {
        project: "MCP",
        session: firstSession,
        op_id: "project-progress-501",
        scope: "project",
        summary: "界".repeat(501),
        completed: [],
        next: [],
        evidence: [],
      },
    });
    expect(rejectedProgress.isError).toBe(true);
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

  it("atm_brief 的 include 真正过滤分节，且带 task_key 时默认预算够用", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "atm-brief-"));
    roots.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: join(process.cwd(), "migrations"),
    });
    const project = await service.createProject({
      name: "brief 预算项目",
      sourcePath: null,
      code: "BRF",
    });
    const server = createAyanamiMcpServer(service);
    const client = new Client({ name: "brief-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    // 准备阶段一旦失败要立刻带着原因炸掉，否则后面会拿 undefined 继续断言。
    const call = async (name: string, args: Record<string, unknown>, expectOk = true) => {
      const res = await client.callTool({ name, arguments: args });
      if (expectOk && res.isError) {
        throw new Error(`${name} 调用失败: ${JSON.stringify(res.content)}`);
      }
      return res;
    };
    const begun = await call("atm_begin", {
      project_code: project.code,
      mode: "project",
      agent_id: "codex",
    });
    const session = String((begun.structuredContent as Record<string, unknown>).session);
    await service.createObjective(project.code, session, {
      title: "目".repeat(80),
      description: "标".repeat(300),
      definitionOfDone: ["完成度可验证"],
    });

    // 把项目撑到真实规模，否则预算下限不会暴露。
    const created = await call("atm_task_create", {
      project: "BRF",
      session,
      op_id: "brief-create-1",
      items: [
        {
          client_ref: "brief-1",
          title: "标".repeat(120),
          description: "述".repeat(900),
          type: "TASK",
          priority: "HIGH",
          status: "READY",
          weight: 1,
          verification_required: true,
          depends_on: [],
          depends_on_refs: [],
          checklist: [],
          acceptance: ["验".repeat(200), "收".repeat(200), "条".repeat(200)],
        },
      ],
    });
    const taskKey = String(
      (created.structuredContent as { created: Array<{ task_key: string }> }).created[0].task_key,
    );
    await call("atm_task_patch", {
      project: "BRF",
      session,
      op_id: "brief-claim-1",
      items: [
        { task_key: taskKey, expected_version: 1, operation: "claim", takeover_stale: false },
      ],
    });
    await call("atm_task_patch", {
      project: "BRF",
      session,
      op_id: "brief-start-1",
      items: [
        { task_key: taskKey, expected_version: 2, operation: "start", takeover_stale: false },
      ],
    });
    for (const n of [1, 2, 3, 4]) {
      await call("atm_record", {
        project: "BRF",
        session,
        op_id: `brief-record-${n}`,
        kind: "FACT",
        title: `事实 ${n} ${"标".repeat(60)}`,
        summary: "要".repeat(300),
        detail: "详".repeat(400),
        importance: "CRITICAL",
        scope: "project",
      });
    }

    // ATM-T-0035：带 task_key 且使用默认 max_chars，不得再返回 RESULT_TOO_LARGE。
    const defaulted = await call("atm_brief", { project_code: "BRF", task_key: taskKey });
    const defaultedBody = defaulted.structuredContent as Record<string, unknown>;
    expect(defaultedBody.code).toBeUndefined();
    expect(defaultedBody).toHaveProperty("task");
    expect(JSON.stringify(defaultedBody).length).toBeLessThanOrEqual(1200);

    // 预算再紧也只能降级，不能退化成 RESULT_TOO_LARGE 空回执；
    // 且优先保住恢复 working set 真正需要的分节。
    const squeezed = await call("atm_brief", {
      project_code: "BRF",
      task_key: taskKey,
      max_chars: 300,
    });
    const squeezedBody = squeezed.structuredContent as Record<string, unknown>;
    expect(squeezedBody.code).toBeUndefined();
    expect(squeezedBody).toHaveProperty("project");
    expect(squeezedBody.truncated).toBe(true);
    expect(JSON.stringify(squeezedBody).length).toBeLessThanOrEqual(300);
    // 泛泛的分节先被丢掉，点名要的 task 比它们活得久。
    expect(squeezedBody).not.toHaveProperty("artifacts");
    expect(squeezedBody).not.toHaveProperty("own");

    // ATM-T-0034：include 非空时只保留被点名的分节，身份字段恒在。
    const filtered = await call("atm_brief", {
      project_code: "BRF",
      task_key: taskKey,
      include: ["current", "task"],
      max_chars: 3000,
    });
    const filteredBody = filtered.structuredContent as Record<string, unknown>;
    expect(Object.keys(filteredBody).sort()).toEqual(
      ["currentTask", "project", "seq", "task", "truncated"].sort(),
    );

    // include 为空保持修复前行为：分节全给。
    const full = await call("atm_brief", { project_code: "BRF", max_chars: 5000 });
    const fullBody = full.structuredContent as Record<string, unknown>;
    for (const key of ["records", "own", "next", "objective", "active"]) {
      expect(fullBody).toHaveProperty(key);
    }

    // include 排除 task 时不返回该分节，即使传了 task_key。
    const withoutTask = await call("atm_brief", {
      project_code: "BRF",
      task_key: taskKey,
      include: ["records"],
      max_chars: 3000,
    });
    expect(withoutTask.structuredContent as Record<string, unknown>).not.toHaveProperty("task");

    // 非法分节名必须报错，而不是像修复前那样被静默丢弃。
    const bogus = await call(
      "atm_brief",
      { project_code: "BRF", include: ["records", "nope"] },
      false,
    );
    expect(bogus.isError).toBe(true);

    await Promise.all([client.close(), server.close()]);
    service.close();
  });
});

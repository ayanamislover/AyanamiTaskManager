import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "@ayanami-task/application";
import { connectProfiledClients } from "./profile-client.js";
import {
  assertMcpSchemaBudget,
  MCP_SCHEMA_LIMIT_BYTES,
  MCP_SCHEMA_RESERVE_BYTES,
} from "../src/schema-budget.js";

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
    const profiles = await connectProfiledClients(service, "mcp-test");
    const { client } = profiles;

    const [coreListed, memoryListed] = await Promise.all([
      profiles.coreClient.listTools(),
      profiles.memoryClient.listTools(),
    ]);
    const allTools = [...coreListed.tools, ...memoryListed.tools];
    expect(coreListed.tools.map((tool) => tool.name)).toEqual([
      "atm_begin",
      "atm_brief",
      "atm_task_list",
      "atm_task_get",
      "atm_task_create",
      "atm_end",
    ]);
    expect(memoryListed.tools.map((tool) => tool.name)).toEqual([
      "atm_task_patch",
      "atm_progress_add",
      "atm_record",
      "atm_search",
      "atm_delta",
    ]);
    const beginSchema = coreListed.tools.find((tool) => tool.name === "atm_begin")?.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(beginSchema.required).toEqual(["agent_id"]);
    expect(beginSchema.properties?.mode).toEqual({
      enum: ["auto", "quick", "project"],
    });
    const recordSchema = memoryListed.tools.find((tool) => tool.name === "atm_record")
      ?.inputSchema as {
      properties?: Record<string, { type?: unknown; enum?: unknown; maxLength?: number }>;
      required?: string[];
    };
    expect(recordSchema.required).toEqual([
      "project",
      "session",
      "op_id",
      "kind",
      "title",
      "summary",
    ]);
    expect(recordSchema.properties?.kind).toMatchObject({
      enum: ["DECISION", "CONSTRAINT", "FACT", "RISK", "REFERENCE", "LESSON"],
    });
    expect(recordSchema.properties?.summary).toMatchObject({
      type: "string",
      maxLength: 300,
    });
    const enumNodes: Array<Record<string, unknown>> = [];
    const collectEnums = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(collectEnums);
        return;
      }
      if (!value || typeof value !== "object") return;
      const node = value as Record<string, unknown>;
      if (Array.isArray(node.enum)) enumNodes.push(node);
      Object.values(node).forEach(collectEnums);
    };
    allTools.forEach((tool) => collectEnums(tool.inputSchema));
    expect(enumNodes.length).toBeGreaterThan(10);
    expect(enumNodes.every((node) => node.type === undefined)).toBe(true);
    const emptySchemaNodes: string[] = [];
    const collectEmptySchemas = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => collectEmptySchemas(entry, `${path}[${index}]`));
        return;
      }
      if (!value || typeof value !== "object") return;
      const node = value as Record<string, unknown>;
      if (Object.keys(node).length === 0) emptySchemaNodes.push(path);
      Object.entries(node).forEach(([key, entry]) => collectEmptySchemas(entry, `${path}.${key}`));
    };
    allTools.forEach((tool) => collectEmptySchemas(tool.inputSchema, tool.name));
    expect(emptySchemaNodes).toEqual([]);
    const schemaBudget = assertMcpSchemaBudget(coreListed.tools);
    expect(schemaBudget).toEqual({
      bytes: expect.any(Number),
      limitBytes: MCP_SCHEMA_LIMIT_BYTES,
      reserveBytes: MCP_SCHEMA_RESERVE_BYTES,
      usableBytes: MCP_SCHEMA_LIMIT_BYTES - MCP_SCHEMA_RESERVE_BYTES,
    });
    // 阳性对照：守卫必须真的会在吃掉预留余量时变红，不能只量一个永远通过的数字。
    expect(() =>
      assertMcpSchemaBudget([
        ...coreListed.tools,
        { name: "oversized", inputSchema: { type: "object", padding: "x".repeat(8000) } },
      ]),
    ).toThrow(/MCP_SCHEMA_BUDGET_EXCEEDED/u);
    expect(allTools.every((tool) => tool.description === undefined)).toBe(true);
    expect(profiles.coreClient.getInstructions()).toContain("MCP surface v3");
    expect(profiles.coreClient.getInstructions()).toContain("直接使用返回的 brief");
    expect(
      JSON.stringify(coreListed.tools.find((tool) => tool.name === "atm_task_create")?.inputSchema),
    ).toContain("discovered_from_ref");

    const invalidContract = await client.callTool({
      name: "atm_record",
      arguments: {
        project: "",
        session: "",
        op_id: "",
        kind: "NOT_A_KIND",
        title: "",
        summary: "界".repeat(301),
      },
    });
    expect(invalidContract.isError).toBe(true);
    const invalidText = JSON.stringify(invalidContract.content);
    for (const field of ["project", "session", "op_id", "kind", "title", "summary"]) {
      expect(invalidText).toContain(field);
    }

    const result = await client.callTool({
      name: "atm_begin",
      arguments: {
        op_id: "mcp-session-begin-same-request",
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
    const replayed = await client.callTool({
      name: "atm_begin",
      arguments: {
        op_id: "mcp-session-begin-same-request",
        project_code: project.code,
        mode: "project",
        agent_id: "codex",
      },
    });
    expect(replayed.structuredContent).toMatchObject({ session: firstSession });
    expect(result.structuredContent).toMatchObject({
      atomicBegin: {
        operationId: "mcp-session-begin-same-request",
        disposition: "CREATED",
      },
    });
    expect(replayed.structuredContent).toMatchObject({
      atomicBegin: {
        operationId: "mcp-session-begin-same-request",
        disposition: "RECOVERED",
      },
    });
    const identityConflict = await client.callTool({
      name: "atm_begin",
      arguments: {
        op_id: "mcp-session-begin-same-request",
        project_code: project.code,
        mode: "project",
        agent_id: "codex",
        thread_id: "thr_mcp_different",
      },
    });
    expect(identityConflict.isError).toBe(true);
    expect(JSON.stringify(identityConflict.content)).toMatch(/IDEMPOTENCY_CONFLICT/i);
    expect(await service.listAgentSessions(project.code)).toHaveLength(1);
    const projectProgress = await client.callTool({
      name: "atm_progress_add",
      arguments: {
        project: "MCP",
        session: firstSession,
        op_id: "project-progress-1",
        scope: "project",
        summary: "进".repeat(300),
        completed: [],
        evidence: [],
      },
    });
    expect(projectProgress.structuredContent).toMatchObject({ ok: true, health: "UNKNOWN" });
    const boundaryProgress = await client.callTool({
      name: "atm_progress_add",
      arguments: {
        project: "MCP",
        session: firstSession,
        op_id: "project-progress-500",
        scope: "project",
        summary: "界".repeat(500),
        completed: [],
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

    await profiles.close();
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
    const profiles = await connectProfiledClients(service, "brief-test");
    const { client } = profiles;

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
      title: "目".repeat(11),
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
          title: "标".repeat(26),
          description: "述".repeat(900),
          type: "TASK",
          priority: "HIGH",
          status: "READY",
          verification_required: true,
          depends_on: [],
          depends_on_refs: [],
          checklist: [],
          acceptance: ["验".repeat(19), "收".repeat(25), "条".repeat(31)],
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
        // 多条中等长度摘要会让 repository brief 刚好卡在 1200 字以内，
        // 再叠加 begin 自己的 session/atomicBegin 外壳后越界；这正是现场形状。
        summary: "要".repeat(87),
        detail: "详".repeat(400),
      });
    }

    // 来自真实多项目恢复场景：begin 在服务端已经创建 Session 后，不能因为 brief
    // 超过 MCP 文本预算就把整个结果替换成 RESULT_TOO_LARGE，连 Session 号也丢掉。
    // 当前 Agent 仍被分派到上面的长任务，且项目已有多条长 Record，足以复现。
    const resumedBegin = await call("atm_begin", {
      op_id: "brief-rich-resume",
      project_code: "BRF",
      mode: "project",
      agent_id: "codex",
      resume: true,
    });
    const resumedBody = resumedBegin.structuredContent as Record<string, unknown>;
    expect(resumedBody.code).toBeUndefined();
    expect(resumedBody).toMatchObject({
      scope: "project",
      project: "BRF",
      surface_version: 3,
      brief_mode: "full",
    });
    expect(resumedBody.session).toEqual(expect.any(String));
    expect(JSON.stringify(resumedBody).length).toBeLessThanOrEqual(1200);

    const identityOnly = await call("atm_begin", {
      op_id: "brief-none",
      project_code: "BRF",
      mode: "project",
      agent_id: "codex-none",
      role: "OBSERVER",
      brief: "none",
      max_chars: 300,
    });
    const identityBody = identityOnly.structuredContent as Record<string, unknown>;
    expect(identityBody).toMatchObject({
      scope: "project",
      project: "BRF",
      surface_version: 3,
      brief_mode: "none",
      brief_truncated: false,
    });
    expect(identityBody.session).toEqual(expect.any(String));
    expect(identityBody).not.toHaveProperty("records");
    expect(JSON.stringify(identityBody).length).toBeLessThanOrEqual(300);

    const minimal = await call("atm_begin", {
      op_id: "brief-minimal",
      project_code: "BRF",
      mode: "project",
      agent_id: "codex-minimal",
      role: "OBSERVER",
      brief: "minimal",
      max_chars: 600,
    });
    const minimalBody = minimal.structuredContent as Record<string, unknown>;
    expect(minimalBody).toMatchObject({
      scope: "project",
      project: "BRF",
      surface_version: 3,
      brief_mode: "minimal",
    });
    expect(minimalBody).not.toHaveProperty("records");
    expect(minimalBody).not.toHaveProperty("objective");
    expect(JSON.stringify(minimalBody).length).toBeLessThanOrEqual(600);

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

    // 原子回执是兼容性/权威证明，项目上下文再大也不能被 1200 字预算整体替换掉。
    const longAtomicOperationId = `atomic-${"x".repeat(120)}`;
    const atomicBegin = await call("atm_begin", {
      op_id: longAtomicOperationId,
      project_code: "BRF",
      mode: "project",
      agent_id: "codex",
      role: "OBSERVER",
    });
    const atomicBody = atomicBegin.structuredContent as Record<string, unknown>;
    expect(atomicBody.code).toBeUndefined();
    expect(atomicBody.atomicBegin).toEqual({
      operationId: longAtomicOperationId,
      disposition: "CREATED",
    });
    expect(typeof atomicBody.session).toBe("string");
    expect(JSON.stringify(atomicBody).length).toBeLessThanOrEqual(1200);

    await profiles.close();
    service.close();
  });
});

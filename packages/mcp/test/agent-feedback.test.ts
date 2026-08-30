import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AyanamiTaskService } from "@ayanami-task/application";
import { afterEach, describe, expect, it } from "vitest";
import { createAyanamiMcpServer } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
});

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "atm-agent-feedback-"));
  roots.push(dataDir);
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: join(process.cwd(), "migrations"),
  });
  const project = await service.createProject({
    name: "Agent feedback",
    sourcePath: null,
    code: "AFB",
  });
  const begun = await service.begin({
    projectCode: project.code,
    agentId: "feedback-agent",
    clientKind: "test-client",
    role: "PRIMARY",
  });
  const server = createAyanamiMcpServer(service, { profile: "memory" });
  const client = new Client({ name: "agent-feedback-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server, service, project, session: String(begun.session) };
}

describe("local Agent feedback MCP entry", () => {
  it("stores a locally visible Agent Record and replays the exact request", async () => {
    const s = await fixture();
    try {
      const listed = await s.client.listTools();
      const feedbackSchema = listed.tools.find((tool) => tool.name === "atm_feedback")
        ?.inputSchema as {
        properties?: Record<string, { enum?: string[]; maxLength?: number }>;
        required?: string[];
      };
      expect(feedbackSchema.required).toEqual(["project", "session", "op_id", "summary"]);
      expect(feedbackSchema.properties?.summary).toMatchObject({ maxLength: 300 });
      expect(feedbackSchema.properties?.severity?.enum).toEqual([
        "LOW",
        "NORMAL",
        "HIGH",
        "CRITICAL",
      ]);

      const payload = {
        project: s.project.code,
        session: s.session,
        op_id: "feedback-exact-replay",
        summary: "atm_task_patch 的版本提示难以理解",
        detail: "希望错误同时给出当前 checklist version。",
        severity: "HIGH",
        tool: "atm_task_patch",
      };
      const created = await s.client.callTool({ name: "atm_feedback", arguments: payload });
      expect(created.isError).not.toBe(true);
      expect(created.structuredContent).toMatchObject({
        ok: true,
        op_id: payload.op_id,
        project: s.project.code,
        session: s.session,
        entities: [{ entity_type: "RECORD", key: expect.any(String), version: 0 }],
      });
      expect(Object.keys(created.structuredContent as Record<string, unknown>).sort()).toEqual(
        [
          "details_cursor",
          "entities",
          "entities_truncated",
          "entity_count",
          "ok",
          "op_id",
          "project",
          "projection",
          "session",
          "session_rebound",
        ].sort(),
      );
      const recordKey = String((created.structuredContent as any).entities[0].key);
      await expect(s.service.getRecord(s.project.code, recordKey)).resolves.toMatchObject({
        key: recordKey,
        kind: "RISK",
        title: `ATM Agent 反馈：${payload.summary}`,
        summary: payload.summary,
        detail: expect.stringContaining(payload.detail),
        importance: payload.severity,
        scope: "ATM_FEEDBACK",
        topic: "atm-agent-feedback",
        sourceType: "AGENT",
        sourceActorId: "feedback-agent",
        sourceSessionId: s.session,
      });
      expect((await s.service.getRecord(s.project.code, recordKey)).detail).toContain(
        "涉及工具：atm_task_patch",
      );

      const replayed = await s.client.callTool({ name: "atm_feedback", arguments: payload });
      expect(replayed.structuredContent).toMatchObject({
        op_id: payload.op_id,
        entities: [{ entity_type: "RECORD", key: recordKey, version: 0 }],
      });
      expect(await s.service.listRecords(s.project.code)).toHaveLength(1);
    } finally {
      await Promise.all([s.client.close(), s.server.close()]);
      s.service.close();
    }
  });

  it("rejects changed feedback under the same op_id without a second write", async () => {
    const s = await fixture();
    try {
      const payload = {
        project: s.project.code,
        session: s.session,
        op_id: "feedback-conflict",
        summary: "搜索结果缺少上下文",
        detail: "第一次提交",
      };
      const created = await s.client.callTool({ name: "atm_feedback", arguments: payload });
      expect(created.isError).not.toBe(true);
      const conflict = await s.client.callTool({
        name: "atm_feedback",
        arguments: { ...payload, detail: "改变后的请求" },
      });
      expect(conflict.isError).toBe(true);
      expect(JSON.stringify(conflict.content)).toContain("IDEMPOTENCY_CONFLICT");
      expect(await s.service.listRecords(s.project.code)).toHaveLength(1);
    } finally {
      await Promise.all([s.client.close(), s.server.close()]);
      s.service.close();
    }
  });
});

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
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function connect(service: AyanamiTaskService) {
  const server = createAyanamiMcpServer(service, { profile: "memory" });
  const client = new Client({ name: "mcp-startup-successor-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe("MCP startup-recovery successor contract", () => {
  it("returns the successor and replays one mutation exactly from the old or new session", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "atm-mcp-startup-successor-"));
    roots.push(dataDir);
    const migrationsRoot = join(process.cwd(), "migrations");
    const bootstrap = await AyanamiTaskService.open({ dataDir, migrationsRoot });
    const project = await bootstrap.createProject({
      name: "MCP startup successor",
      sourcePath: null,
      code: "MSUCC",
    });
    const first = await bootstrap.begin({
      projectCode: project.code,
      mode: "project",
      agentId: "mcp-successor-agent",
      clientKind: "test",
      threadId: "mcp-successor-thread",
    });
    const database = await bootstrap.databases.openProject(project.code);
    database.sqlite
      .prepare("UPDATE agent_sessions SET heartbeat_at = ?, updated_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", String(first.session));
    bootstrap.close();

    const service = await AyanamiTaskService.open({ dataDir, migrationsRoot });
    const { client, server } = await connect(service);
    try {
      const payload = {
        project: project.code,
        session: String(first.session),
        op_id: "mcp-successor-record",
        kind: "FACT",
        title: "Recovered mutation",
        summary: "Startup recovery creates exactly one successor.",
      };
      const created = await client.callTool({ name: "atm_record", arguments: payload });
      expect(created.isError).not.toBe(true);
      expect(created.structuredContent).toMatchObject({
        op_id: payload.op_id,
        session_rebound: true,
        session: expect.any(String),
        new_session: expect.any(String),
        record: expect.any(String),
      });
      const createdAck = created.structuredContent as Record<string, unknown>;
      expect(createdAck.new_session).toBe(createdAck.session);

      const replayedOld = await client.callTool({ name: "atm_record", arguments: payload });
      expect(replayedOld.structuredContent).toMatchObject({
        op_id: payload.op_id,
        session_rebound: true,
        session: createdAck.new_session,
        new_session: createdAck.new_session,
        record: createdAck.record,
      });

      const replayedNew = await client.callTool({
        name: "atm_record",
        arguments: { ...payload, session: createdAck.new_session },
      });
      expect(replayedNew.structuredContent).toMatchObject({
        op_id: payload.op_id,
        record: createdAck.record,
      });

      const conflict = await client.callTool({
        name: "atm_record",
        arguments: { ...payload, summary: "Changed payload must conflict." },
      });
      expect(conflict.isError).toBe(true);
      expect(JSON.stringify(conflict.content)).toContain("IDEMPOTENCY_CONFLICT");
      expect(await service.listRecords(project.code, 20)).toHaveLength(1);
      expect(await service.listAgentSessions(project.code, 20)).toHaveLength(2);
      expect((await service.delta(project.code, 0, 100, ["record.created"])).events).toHaveLength(
        1,
      );
    } finally {
      await Promise.all([client.close(), server.close()]);
      service.close();
    }
  });

  it("does not revive explicitly closed, retired, or force-closed sessions", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "atm-mcp-no-successor-"));
    roots.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: join(process.cwd(), "migrations"),
    });
    const project = await service.createProject({
      name: "MCP explicit close",
      sourcePath: null,
      code: "MSTOP",
    });
    const begin = (agentId: string) =>
      service.begin({
        projectCode: project.code,
        mode: "project",
        agentId,
        clientKind: "test",
      });
    const explicitlyClosed = await begin("explicit-close-agent");
    const retired = await begin("retired-agent");
    const forceClosed = await begin("force-close-agent");
    await service.end(project.code, String(explicitlyClosed.session), "explicit-end", {
      outcome: "completed",
      summary: "Explicitly completed",
      next: [],
      releaseClaims: true,
    });
    await service.end(project.code, String(retired.session), "retired-end", {
      outcome: "retired",
      summary: "Explicitly retired",
      next: [],
      releaseClaims: true,
      retirementReason: "context rotation",
    });
    await service.forceCloseSessionAsUser(project.code, String(forceClosed.session), true);

    const { client, server } = await connect(service);
    try {
      for (const [index, session] of [explicitlyClosed, retired, forceClosed].entries()) {
        const rejected = await client.callTool({
          name: "atm_record",
          arguments: {
            project: project.code,
            session: String(session.session),
            op_id: `closed-session-record-${index}`,
            kind: "FACT",
            title: "Must remain closed",
            summary: "Only heartbeat timeout may create a startup successor.",
          },
        });
        expect(rejected.isError).toBe(true);
        expect(JSON.stringify(rejected.content)).toContain("SESSION_CLOSED");
      }
      expect(await service.listAgentSessions(project.code, 20)).toHaveLength(3);
      expect(await service.listRecords(project.code, 20)).toEqual([]);
    } finally {
      await Promise.all([client.close(), server.close()]);
      service.close();
    }
  });
});

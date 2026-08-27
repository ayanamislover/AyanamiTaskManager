import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "@ayanami-task/application";
import { connectProfiledClients } from "./profile-client.js";

const roots: string[] = [];
const services: AyanamiTaskService[] = [];
const connections: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of connections.splice(0)) await close();
  for (const service of services.splice(0)) service.close();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
});

describe("heartbeat successor + planning-root first task", () => {
  it("creates one successor/root/task atomically and replays through either Session id", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "atm-mcp-successor-planning-root-"));
    roots.push(dataDir);
    const migrationsRoot = join(process.cwd(), "migrations");
    const bootstrap = await AyanamiTaskService.open({ dataDir, migrationsRoot });
    const project = await bootstrap.createProject({
      name: "Successor planning root",
      sourcePath: null,
      code: "SPROOT",
    });
    const begun = await bootstrap.begin({
      projectCode: project.code,
      mode: "project",
      agentId: "successor-planning-agent",
      displayName: "Successor Planning Agent",
      clientKind: "test",
      threadId: "successor-planning-thread",
      role: "PRIMARY",
    });
    const database = await bootstrap.databases.openProject(project.code);
    database.sqlite
      .prepare("UPDATE agent_sessions SET heartbeat_at = ?, updated_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", String(begun.session));
    bootstrap.close();

    const service = await AyanamiTaskService.open({ dataDir, migrationsRoot });
    services.push(service);
    const profiles = await connectProfiledClients(service, "successor-planning-root-test");
    connections.push(profiles.close);

    const payload = {
      project: project.code,
      session: String(begun.session),
      op_id: "successor-planning-first-task",
      items: [
        {
          client_ref: "first-task",
          title: "空项目的首个任务",
          description: "过期 Session 应在同一原子命令中恢复并补建规划根",
          type: "TASK",
          priority: "HIGH",
          status: "READY",
          depends_on: [],
          depends_on_refs: [],
          acceptance: ["只创建一个 successor、规划根和任务"],
          checklist: [],
          verification_required: false,
        },
      ],
    };

    const created = await profiles.client.callTool({
      name: "atm_task_create",
      arguments: payload,
    });
    expect(created.isError, JSON.stringify(created.content)).not.toBe(true);
    expect(created.structuredContent).toMatchObject({
      op_id: payload.op_id,
      session_rebound: true,
      session: expect.any(String),
      entities: [expect.objectContaining({ entity_type: "WORK_ITEM", key: expect.any(String) })],
    });
    const ack = created.structuredContent as Record<string, any>;
    const successorSession = String(ack.session);
    const receipt = await profiles.memoryClient.callTool({
      name: "atm_search",
      arguments: {
        project: project.code,
        op_id: payload.op_id,
        session: successorSession,
        max_chars: 20_000,
      },
    });
    expect(
      (receipt.structuredContent as Record<string, any>).operation.mutations[0].response,
    ).toMatchObject({ planningRootProvisioned: true });

    expect(await service.listAgentSessions(project.code, 20)).toHaveLength(2);
    expect(await service.listObjectives(project.code)).toHaveLength(1);
    expect(await service.listMilestones(project.code)).toHaveLength(1);
    expect(await service.listWorkItems(project.code, { limit: 20 })).toHaveLength(1);

    const replayedOld = await profiles.client.callTool({
      name: "atm_task_create",
      arguments: payload,
    });
    expect(replayedOld.isError).not.toBe(true);
    expect(replayedOld.structuredContent).toMatchObject({
      op_id: payload.op_id,
      session_rebound: true,
      session: successorSession,
      entities: ack.entities,
    });

    const replayedNew = await profiles.client.callTool({
      name: "atm_task_create",
      arguments: { ...payload, session: successorSession },
    });
    expect(replayedNew.isError).not.toBe(true);
    expect(replayedNew.structuredContent).toMatchObject({
      op_id: payload.op_id,
      session: successorSession,
      session_rebound: false,
      entities: ack.entities,
    });

    expect(await service.listAgentSessions(project.code, 20)).toHaveLength(2);
    expect(await service.listObjectives(project.code)).toHaveLength(1);
    expect(await service.listMilestones(project.code)).toHaveLength(1);
    expect(await service.listWorkItems(project.code, { limit: 20 })).toHaveLength(1);
  }, 30_000);
});

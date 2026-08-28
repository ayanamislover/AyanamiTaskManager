import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AyanamiTaskService } from "@ayanami-task/application";
import { afterEach, describe, expect, it } from "vitest";
import { connectProfiledClients } from "./profile-client.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
});

describe("durable MCP mutation receipts", () => {
  it("returns a fixed batch acknowledgement and restores every entity after restart", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "atm-mcp-durable-receipt-"));
    roots.push(dataDir);
    const migrationsRoot = join(process.cwd(), "migrations");
    let service = await AyanamiTaskService.open({ dataDir, migrationsRoot });
    const project = await service.createProject({
      name: "Durable mutation receipts",
      sourcePath: null,
      code: "RCPT",
    });
    let profiles = await connectProfiledClients(service, "durable-receipt-write");

    const begun = await profiles.coreClient.callTool({
      name: "atm_begin",
      arguments: {
        project_code: project.code,
        mode: "project",
        agent_id: "durable-receipt-agent",
        op_id: "durable-receipt-begin",
        brief: "none",
      },
    });
    const session = String((begun.structuredContent as Record<string, unknown>).session);
    const opId = "durable-batch-create";
    const created = await profiles.coreClient.callTool({
      name: "atm_task_create",
      arguments: {
        project: project.code,
        session,
        op_id: opId,
        items: Array.from({ length: 20 }, (_, index) => ({
          client_ref: `receipt-${String(index).padStart(2, "0")}-${"x".repeat(75)}`,
          title: `Durable receipt task ${index}`,
          status: "READY",
        })),
      },
    });

    const acknowledgement = created.structuredContent as Record<string, any>;
    expect(Object.keys(acknowledgement).sort()).toEqual(
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
    expect(acknowledgement).toMatchObject({
      ok: true,
      op_id: opId,
      project: project.code,
      session,
      session_rebound: false,
      projection: {
        status: "APPLIED",
        source_seq: expect.any(Number),
        projected_seq: expect.any(Number),
        retry_scheduled: false,
        last_error: null,
        retry_count: 0,
      },
      details_cursor: {
        name: "atm_search",
        arguments: {
          project: project.code,
          op_id: opId,
          session,
          field_mask: ["op_id", "entities"],
          max_chars: 50_000,
        },
      },
    });
    expect(acknowledgement.entity_count).toBe(20);
    expect(acknowledgement.entities_truncated).toBe(true);
    expect(acknowledgement.entities.length).toBeLessThan(20);
    expect(JSON.stringify(acknowledgement.entities).length).toBeLessThanOrEqual(1800);
    expect(JSON.stringify(acknowledgement).length).toBeLessThan(4000);
    expect(acknowledgement.entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entity_type: "WORK_ITEM", key: "RCPT-T-0001", version: 1 }),
      ]),
    );

    const replayed = await profiles.coreClient.callTool({
      name: "atm_task_create",
      arguments: {
        project: project.code,
        session,
        op_id: opId,
        items: Array.from({ length: 20 }, (_, index) => ({
          client_ref: `receipt-${String(index).padStart(2, "0")}-${"x".repeat(75)}`,
          title: `Durable receipt task ${index}`,
          status: "READY",
        })),
      },
    });
    expect(replayed.structuredContent).toEqual(acknowledgement);

    await profiles.close();
    service.close();

    service = await AyanamiTaskService.open({ dataDir, migrationsRoot });
    profiles = await connectProfiledClients(service, "durable-receipt-read");
    try {
      const restored = await profiles.memoryClient.callTool(acknowledgement.details_cursor);
      expect(restored.isError).not.toBe(true);
      const operation = (restored.structuredContent as Record<string, any>).operation;
      expect(operation.op_id).toBe(opId);
      expect(operation.entities).toHaveLength(20);
      expect(operation.entities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ entity_type: "WORK_ITEM", key: "RCPT-T-0001", version: 1 }),
          expect.objectContaining({ entity_type: "WORK_ITEM", key: "RCPT-T-0020", version: 1 }),
        ]),
      );

      const patchOpId = "durable-batch-patch";
      const patchArguments = {
        project: project.code,
        session,
        op_id: patchOpId,
        items: (operation.entities as Array<{ key: string; version: number }>).map((entity) => ({
          task_key: entity.key,
          expected_version: entity.version,
          operation: "start",
        })),
      };
      const patched = await profiles.actionsClient.callTool({
        name: "atm_task_patch",
        arguments: patchArguments,
      });
      const patchAcknowledgement = patched.structuredContent as Record<string, any>;
      expect(patchAcknowledgement).toMatchObject({
        ok: true,
        op_id: patchOpId,
        session,
        session_rebound: false,
        entity_count: 20,
        entities_truncated: true,
      });
      expect(patchAcknowledgement.entities.length).toBeLessThan(20);
      expect(JSON.stringify(patchAcknowledgement.entities).length).toBeLessThanOrEqual(1800);
      expect(JSON.stringify(patchAcknowledgement).length).toBeLessThan(4000);

      const replayedPatch = await profiles.actionsClient.callTool({
        name: "atm_task_patch",
        arguments: patchArguments,
      });
      expect(replayedPatch.structuredContent).toEqual(patchAcknowledgement);

      await profiles.close();
      service.close();
      service = await AyanamiTaskService.open({ dataDir, migrationsRoot });
      profiles = await connectProfiledClients(service, "durable-patch-receipt-read");
      const restoredPatch = await profiles.memoryClient.callTool(
        patchAcknowledgement.details_cursor,
      );
      expect(restoredPatch.isError).not.toBe(true);
      const patchOperation = (restoredPatch.structuredContent as Record<string, any>).operation;
      expect(patchOperation.entities).toHaveLength(20);
      expect(patchOperation.entities).toEqual(
        expect.arrayContaining([
          { entity_type: "WORK_ITEM", key: "RCPT-T-0001", version: 2 },
          { entity_type: "WORK_ITEM", key: "RCPT-T-0020", version: 2 },
        ]),
      );
    } finally {
      await profiles.close();
      service.close();
    }
  });

  it("returns DEFERRED as a successful fixed ACK when Registry projection fails", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "atm-mcp-deferred-receipt-"));
    roots.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: join(process.cwd(), "migrations"),
    });
    const project = await service.createProject({
      name: "Deferred MCP receipt",
      sourcePath: null,
      code: "DMR",
    });
    const profiles = await connectProfiledClients(service, "deferred-receipt-write");
    try {
      const begun = await profiles.coreClient.callTool({
        name: "atm_begin",
        arguments: {
          project_code: project.code,
          mode: "project",
          agent_id: "deferred-receipt-agent",
          op_id: "deferred-receipt-begin",
          brief: "none",
        },
      });
      const session = String((begun.structuredContent as Record<string, unknown>).session);
      service.databases.registry.sqlite.exec(`
        CREATE TRIGGER fail_mcp_projection
        BEFORE UPDATE OF project_sequence ON project_summary_cache
        WHEN NEW.project_id = '${project.id}'
        BEGIN
          SELECT RAISE(ABORT, 'injected MCP projection failure');
        END;
      `);

      const created = await profiles.coreClient.callTool({
        name: "atm_task_create",
        arguments: {
          project: project.code,
          session,
          op_id: "deferred-receipt-create",
          items: [{ client_ref: "deferred", title: "Durable authoritative task" }],
        },
      });
      expect(created.isError).not.toBe(true);
      expect(created.structuredContent).toMatchObject({
        ok: true,
        op_id: "deferred-receipt-create",
        projection: {
          status: "DEFERRED",
          source_seq: expect.any(Number),
          projected_seq: expect.any(Number),
          retry_scheduled: true,
          last_error: expect.stringContaining("injected MCP projection failure"),
          retry_count: 1,
        },
      });
      expect(
        (await service.databases.openProject(project.id)).sqlite
          .prepare("SELECT COUNT(*) AS count FROM work_items")
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      await profiles.close();
      service.close();
    }
  });
});

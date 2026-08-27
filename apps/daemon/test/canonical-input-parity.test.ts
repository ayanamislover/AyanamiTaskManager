import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "@ayanami-task/application";
import { createAyanamiMcpServer } from "@ayanami-task/mcp";
import { buildAyanamiServer } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
});

describe("REST camelCase / MCP snake_case canonical input parity", () => {
  it("rejects the same four business-invalid inputs and passes canonical values to Application", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "atm-canonical-parity-"));
    roots.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: join(process.cwd(), "migrations"),
    });
    await service.createProject({ name: "Canonical parity", sourcePath: null, code: "CPAR" });
    const begun = await service.begin({
      projectCode: "CPAR",
      mode: "project",
      agentId: "parity-agent",
    });
    const session = String(begun.session);
    const app = await buildAyanamiServer({ service, token: "parity-token" });
    const mcpServer = createAyanamiMcpServer(service, { profile: "core" });
    const client = new Client({ name: "canonical-parity", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);

    const restCreate = (item: Record<string, unknown>, opId: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/projects/CPAR/work-items",
        headers: { authorization: "Bearer parity-token" },
        payload: { session, opId, items: [item] },
      });
    const mcpCreate = (item: Record<string, unknown>, opId: string) =>
      client.callTool({
        name: "atm_task_create",
        arguments: { project: "CPAR", session, op_id: opId, items: [item] },
      });
    const restItem = {
      clientRef: "parity-rest",
      title: "Parity task",
      status: "READY",
      acceptance: [],
      checklist: [],
    };
    const mcpItem = {
      client_ref: "parity-mcp",
      title: "Parity task",
      status: "READY",
      acceptance: [],
      checklist: [],
    };

    try {
      const restThread = await app.inject({
        method: "POST",
        url: "/api/v1/sessions",
        headers: { authorization: "Bearer parity-token" },
        payload: {
          projectCode: "CPAR",
          mode: "project",
          agentId: "rest-thread",
          threadId: "t".repeat(257),
        },
      });
      const mcpThread = await client.callTool({
        name: "atm_begin",
        arguments: {
          project_code: "CPAR",
          mode: "project",
          agent_id: "mcp-thread",
          thread_id: "t".repeat(257),
        },
      });
      expect(restThread.statusCode).toBe(400);
      expect(restThread.json()).toMatchObject({
        error: { code: "INVALID_ARGUMENT", details: { issues: [{ path: "threadId" }] } },
      });
      expect(mcpThread.isError).toBe(true);
      expect(JSON.stringify(mcpThread)).toContain("thread_id");

      const parityCases = [
        {
          label: "target date",
          rest: { ...restItem, clientRef: "bad-date-rest", targetDate: "2026/08/27" },
          mcp: { ...mcpItem, client_ref: "bad-date-mcp", target_date: "2026/08/27" },
          restPath: "items.0.targetDate",
          mcpPath: "target_date",
        },
        {
          label: "blank acceptance",
          rest: { ...restItem, clientRef: "blank-accept-rest", acceptance: ["   "] },
          mcp: { ...mcpItem, client_ref: "blank-accept-mcp", acceptance: ["   "] },
          restPath: "items.0.acceptance.0",
          mcpPath: "acceptance",
        },
        {
          label: "blank checklist title",
          rest: {
            ...restItem,
            clientRef: "blank-check-rest",
            checklist: [{ title: "   " }],
          },
          mcp: {
            ...mcpItem,
            client_ref: "blank-check-mcp",
            checklist: [{ title: "   " }],
          },
          restPath: "items.0.checklist.0.title",
          mcpPath: "title",
        },
      ] as const;

      for (const [index, parityCase] of parityCases.entries()) {
        const rest = await restCreate(parityCase.rest, `rest-invalid-${index}`);
        const mcp = await mcpCreate(parityCase.mcp, `mcp-invalid-${index}`);
        expect(rest.statusCode, parityCase.label).toBe(400);
        expect(JSON.stringify(rest.json()), parityCase.label).toContain(parityCase.restPath);
        expect(mcp.isError, parityCase.label).toBe(true);
        expect(JSON.stringify(mcp), parityCase.label).toContain(parityCase.mcpPath);
      }

      const accepted = await mcpCreate(
        {
          ...mcpItem,
          client_ref: "canonical-success",
          acceptance: ["  可验收  "],
          checklist: [{ title: "  留证  ", evidence_required: true }],
          target_date: "2026-08-27",
        },
        "canonical-success-op",
      );
      expect(accepted.isError).not.toBe(true);
      const created = (
        accepted.structuredContent as {
          entities: Array<{ entity_type: string; key: string }>;
        }
      ).entities.find((entity) => entity.entity_type === "WORK_ITEM");
      if (!created) throw new Error("WORK_ITEM_MUTATION_ENTITY_MISSING");
      const stored = await service.getWorkItem("CPAR", created.key, "full");
      expect(stored).toMatchObject({
        acceptance: ["可验收"],
        checklist: [{ title: "留证", evidenceRequired: true }],
      });
    } finally {
      await Promise.all([client.close(), mcpServer.close(), app.close()]);
      service.close();
    }
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AyanamiTaskService } from "@ayanami-task/application";
import { afterEach, describe, expect, it } from "vitest";
import { createAyanamiMcpServer } from "../src/index.js";

const temporary: string[] = [];

afterEach(async () => {
  for (const directory of temporary.splice(0)) {
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
});

const CORE_KEYS = [
  "key",
  "phase",
  "progress",
  "progress_source",
  "status",
  "updated_at",
  "version",
  "waiting_on",
].sort();

const CONTEXT_KEYS = [
  ...CORE_KEYS,
  "acceptance",
  "assignee_agent_id",
  "blocked_reason",
  "checklist_summary",
  "description_preview",
  "title",
  "waiting_for",
].sort();

const FULL_KEYS = [...CONTEXT_KEYS, "checklist", "description", "relations"].sort();

type Fixture = {
  service: AyanamiTaskService;
  project: string;
  taskKey: string;
  parentKey: string;
  dependencyKey: string;
  description: string;
};

async function openFixture(code: string): Promise<Fixture> {
  const dataDir = await mkdtemp(join(tmpdir(), "atm-mcp-task-view-"));
  temporary.push(dataDir);
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: join(process.cwd(), "migrations"),
  });
  await service.createProject({ name: "MCP task view contract", sourcePath: null, code });
  const objective = await service.createObjectiveAsUser(code, "task-view-objective", {
    title: "Canonical task views",
    description: "",
    definitionOfDone: [],
  });
  const description = `${"Context preview text. ".repeat(40)}FULL-DETAIL-TAIL`;
  const created = await service.createWorkItemsAsUser(code, "task-view-items", [
    {
      clientRef: "parent",
      objectiveId: objective.id,
      title: "Parent",
      description: "Parent detail",
      type: "EPIC",
      priority: "NORMAL",
      status: "BACKLOG",
    },
    {
      clientRef: "dependency",
      objectiveId: objective.id,
      title: "Dependency",
      description: "Dependency detail",
      type: "TASK",
      priority: "HIGH",
      status: "READY",
    },
    {
      clientRef: "target",
      objectiveId: objective.id,
      parentRef: "parent",
      dependsOnRefs: ["dependency"],
      title: "Canonical projection target",
      description,
      type: "TASK",
      priority: "HIGH",
      status: "READY",
      acceptance: ["The canonical view is shared by list and get"],
      checklist: [
        { title: "Evidence-backed check", evidenceRequired: true },
        { title: "Still pending", evidenceRequired: true },
      ],
    },
  ]);
  const parentKey = created.items.find((item) => item.title === "Parent")!.key;
  const dependencyKey = created.items.find((item) => item.title === "Dependency")!.key;
  const taskKey = created.items.find((item) => item.title === "Canonical projection target")!.key;
  const stored = await service.getWorkItem(code, taskKey, "full");
  await service.updateChecklistAsUser(code, "task-view-evidence", {
    checklistId: stored.checklist[0]!.id,
    expectedVersion: stored.checklist[0]!.version,
    status: "DONE",
    evidence: ["mcp-contract-proof"],
  });
  return { service, project: code, taskKey, parentKey, dependencyKey, description };
}

async function connect(service: AyanamiTaskService) {
  const server = createAyanamiMcpServer(service);
  const client = new Client({ name: "task-view-contract", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: () => Promise.all([client.close(), server.close()]) };
}

async function readPair(client: Client, fixture: Fixture, view: "core" | "context" | "full") {
  const [listResponse, getResponse] = await Promise.all([
    client.callTool({
      name: "atm_task_list",
      arguments: { project: fixture.project, view, limit: 100, max_chars: 50_000 },
    }),
    client.callTool({
      name: "atm_task_get",
      arguments: {
        project: fixture.project,
        task_key: fixture.taskKey,
        view,
        max_chars: 50_000,
      },
    }),
  ]);
  expect(listResponse.isError).not.toBe(true);
  expect(getResponse.isError).not.toBe(true);
  const listBody = listResponse.structuredContent as { items: Array<Record<string, any>> };
  return {
    listed: listBody.items.find((item) => item.key === fixture.taskKey)!,
    detail: getResponse.structuredContent as Record<string, any>,
  };
}

describe("MCP task view contract", () => {
  it("externalizes a bounded snake_case core identically in list/get", async () => {
    const fixture = await openFixture("TVMC");
    const connection = await connect(fixture.service);
    try {
      const { detail, listed } = await readPair(connection.client, fixture, "core");

      expect(Object.keys(detail).sort()).toEqual(CORE_KEYS);
      expect(Object.keys(listed).sort()).toEqual(CORE_KEYS);
      expect(listed).toEqual(detail);
      expect(JSON.stringify(detail)).not.toContain("FULL-DETAIL-TAIL");
      expect(detail).not.toHaveProperty("title");
      expect(detail).not.toHaveProperty("acceptance");
      expect(detail).not.toHaveProperty("checklist");
    } finally {
      await connection.close();
      fixture.service.close();
    }
  });

  it("externalizes only bounded context and checklist summary identically in list/get", async () => {
    const fixture = await openFixture("TVMX");
    const connection = await connect(fixture.service);
    try {
      const { detail, listed } = await readPair(connection.client, fixture, "context");

      expect(Object.keys(detail).sort()).toEqual(CONTEXT_KEYS);
      expect(Object.keys(listed).sort()).toEqual(CONTEXT_KEYS);
      expect(listed).toEqual(detail);
      expect(detail.description_preview.length).toBeLessThanOrEqual(240);
      expect(detail.description_preview).not.toContain("FULL-DETAIL-TAIL");
      expect(detail.checklist_summary).toEqual({
        total: 2,
        todo: 1,
        doing: 0,
        done: 1,
        skipped: 0,
        evidence_required: 2,
        evidence_missing: 1,
      });
      expect(detail).not.toHaveProperty("description");
      expect(detail).not.toHaveProperty("checklist");
      expect(JSON.stringify(detail)).not.toContain("mcp-contract-proof");
    } finally {
      await connection.close();
      fixture.service.close();
    }
  });

  it("externalizes full description, checklist evidence and relations identically in list/get", async () => {
    const fixture = await openFixture("TVMF");
    const connection = await connect(fixture.service);
    try {
      const { detail, listed } = await readPair(connection.client, fixture, "full");

      expect(Object.keys(detail).sort()).toEqual(FULL_KEYS);
      expect(Object.keys(listed).sort()).toEqual(FULL_KEYS);
      expect(listed).toEqual(detail);
      expect(detail.description).toBe(fixture.description);
      expect(detail.checklist[0]).toMatchObject({
        title: "Evidence-backed check",
        status: "DONE",
        evidence: ["mcp-contract-proof"],
      });
      expect(Array.isArray(detail.relations)).toBe(true);
      expect(JSON.stringify(detail.relations)).toContain(fixture.parentKey);
      expect(JSON.stringify(detail.relations)).toContain(fixture.dependencyKey);
    } finally {
      await connection.close();
      fixture.service.close();
    }
  });
});

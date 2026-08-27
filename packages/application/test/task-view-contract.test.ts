import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "../src/index.js";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const CORE_KEYS = [
  "key",
  "phase",
  "progress",
  "progressSource",
  "status",
  "updatedAt",
  "version",
  "waitingOn",
].sort();

const CONTEXT_KEYS = [
  ...CORE_KEYS,
  "acceptance",
  "assigneeAgentId",
  "blockedReason",
  "checklistSummary",
  "descriptionPreview",
  "title",
  "waitingFor",
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
  const dataDir = mkdtempSync(join(tmpdir(), "atm-application-task-view-"));
  temporary.push(dataDir);
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  await service.createProject({ name: "Task view contract", sourcePath: null, code });
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
    evidence: ["application-contract-proof"],
  });
  return { service, project: code, taskKey, parentKey, dependencyKey, description };
}

async function readPair(fixture: Fixture, view: "core" | "context" | "full") {
  const detail = (await fixture.service.getWorkItem(
    fixture.project,
    fixture.taskKey,
    view,
  )) as unknown as Record<string, any>;
  const listed = (await (fixture.service as any).listWorkItems(
    fixture.project,
    { limit: 100 },
    view,
  )) as Array<Record<string, any>>;
  return { detail, listed: listed.find((item) => item.key === fixture.taskKey)! };
}

describe("Application task view contract", () => {
  it("keeps core bounded to canonical task state and identical in list/get", async () => {
    const fixture = await openFixture("TVAC");
    try {
      const { detail, listed } = await readPair(fixture, "core");

      expect(Object.keys(detail).sort()).toEqual(CORE_KEYS);
      expect(Object.keys(listed).sort()).toEqual(CORE_KEYS);
      expect(listed).toEqual(detail);
      expect(JSON.stringify(detail)).not.toContain("FULL-DETAIL-TAIL");
      expect(detail).not.toHaveProperty("title");
      expect(detail).not.toHaveProperty("acceptance");
      expect(detail).not.toHaveProperty("checklist");
    } finally {
      fixture.service.close();
    }
  });

  it("adds only bounded context and a checklist summary, with list/get parity", async () => {
    const fixture = await openFixture("TVAX");
    try {
      const { detail, listed } = await readPair(fixture, "context");

      expect(Object.keys(detail).sort()).toEqual(CONTEXT_KEYS);
      expect(Object.keys(listed).sort()).toEqual(CONTEXT_KEYS);
      expect(listed).toEqual(detail);
      expect(detail.descriptionPreview.length).toBeLessThanOrEqual(240);
      expect(detail.descriptionPreview).not.toContain("FULL-DETAIL-TAIL");
      expect(detail.checklistSummary).toEqual({
        total: 2,
        todo: 1,
        doing: 0,
        done: 1,
        skipped: 0,
        evidenceRequired: 2,
        evidenceMissing: 1,
      });
      expect(detail).not.toHaveProperty("description");
      expect(detail).not.toHaveProperty("checklist");
      expect(JSON.stringify(detail)).not.toContain("application-contract-proof");
    } finally {
      fixture.service.close();
    }
  });

  it("returns full description, checklist evidence and relations identically in list/get", async () => {
    const fixture = await openFixture("TVAF");
    try {
      const { detail, listed } = await readPair(fixture, "full");

      expect(Object.keys(detail).sort()).toEqual(FULL_KEYS);
      expect(Object.keys(listed).sort()).toEqual(FULL_KEYS);
      expect(listed).toEqual(detail);
      expect(detail.description).toBe(fixture.description);
      expect(detail.checklist[0]).toMatchObject({
        title: "Evidence-backed check",
        status: "DONE",
        evidence: ["application-contract-proof"],
      });
      expect(Array.isArray(detail.relations)).toBe(true);
      expect(JSON.stringify(detail.relations)).toContain(fixture.parentKey);
      expect(JSON.stringify(detail.relations)).toContain(fixture.dependencyKey);
    } finally {
      fixture.service.close();
    }
  });
});

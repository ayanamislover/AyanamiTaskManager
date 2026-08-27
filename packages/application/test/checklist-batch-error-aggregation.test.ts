import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "../src/index.js";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
});

type TypedReason = {
  code: string;
  task_key?: string;
  checklist_id?: string;
  expected?: number;
  actual?: number;
};

type TypedFailure = Error & {
  code?: string;
  details?: { reasons?: TypedReason[] };
};

function durableCounts(database: { sqlite: any }) {
  const count = (table: string) =>
    Number(
      (database.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
        .count,
    );
  const meta = database.sqlite
    .prepare("SELECT current_sequence FROM project_meta WHERE singleton = 1")
    .get() as { current_sequence: number };
  return {
    events: count("events"),
    outbox: count("outbox"),
    idempotency: count("idempotency_keys"),
    sequence: Number(meta.current_sequence),
  };
}

function taskMutationState(task: any) {
  return {
    status: task.status,
    version: task.version,
    progress: task.progress,
    progressSource: task.progressSource,
    checklist: task.checklist.map((item: any) => ({
      id: item.id,
      status: item.status,
      version: item.version,
      evidence: item.evidence,
    })),
  };
}

describe("batch checklist validation aggregation", () => {
  it("returns every typed reason in deterministic order and writes nothing", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-checklist-error-aggregation-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      const project = await service.createProject({
        name: "Checklist error aggregation",
        sourcePath: null,
        code: "CAGG",
      });
      const begun = await service.begin({
        projectCode: project.code,
        mode: "project",
        agentId: "checklist-aggregation-agent",
        clientKind: "test",
        role: "PRIMARY",
      });
      const objective = await service.createObjective(project.code, begun.session, {
        title: "聚合所有错误",
        description: "",
        definitionOfDone: [],
      });
      const created = await service.createWorkItems(
        project.code,
        begun.session,
        "create-checklist-aggregation-fixture",
        [
          {
            clientRef: "primary",
            objectiveId: objective.id,
            title: "被批量更新的任务",
            type: "TASK",
            priority: "HIGH",
            status: "READY",
            verificationRequired: true,
            checklist: [
              { title: "测试证据", evidenceRequired: true },
              { title: "类型检查证据", evidenceRequired: true },
            ],
          },
          {
            clientRef: "foreign",
            objectiveId: objective.id,
            title: "拥有外部 checklist 的任务",
            type: "TASK",
            priority: "NORMAL",
            status: "READY",
            verificationRequired: false,
            checklist: [{ title: "不属于主任务", evidenceRequired: false }],
          },
        ],
      );
      const started = await service.patchWorkItems(
        project.code,
        begun.session,
        "start-checklist-aggregation-fixture",
        [
          {
            taskKey: created.items[0]!.key,
            expectedVersion: created.items[0]!.version,
            operation: "start",
          },
        ],
      );
      const primary = await service.getWorkItem(project.code, started.items[0]!.key, "full");
      const foreign = await service.getWorkItem(project.code, created.items[1]!.key, "full");
      const database = await service.databases.openProject(project.code);
      const beforeCounts = durableCounts(database);
      const beforePrimary = taskMutationState(primary);
      const staleVersion = primary.version - 1;
      const missingId = "01J00000000000000000000000";

      let failure: TypedFailure | undefined;
      try {
        await service.updateChecklistBatch(
          project.code,
          begun.session,
          "aggregate-checklist-errors",
          {
            taskKey: primary.key,
            expectedVersion: staleVersion,
            items: [
              { checklistId: primary.checklist[0]!.id, status: "DONE", evidence: [] },
              { checklistId: primary.checklist[1]!.id, status: "DONE", evidence: [] },
              {
                checklistId: foreign.checklist[0]!.id,
                status: "DONE",
                evidence: ["foreign proof"],
              },
              { checklistId: missingId, status: "DONE", evidence: ["missing proof"] },
            ],
          },
        );
      } catch (error) {
        failure = error as TypedFailure;
      }

      expect(failure).toBeInstanceOf(Error);
      expect(failure).toMatchObject({
        code: "COMPLETION_GATE_FAILED",
        details: {
          reasons: [
            {
              task_key: primary.key,
              code: "VERSION_CONFLICT",
              expected: staleVersion,
              actual: primary.version,
            },
            { checklist_id: primary.checklist[0]!.id, code: "EVIDENCE_REQUIRED" },
            { checklist_id: primary.checklist[1]!.id, code: "EVIDENCE_REQUIRED" },
            { checklist_id: foreign.checklist[0]!.id, code: "TASK_MISMATCH" },
            { checklist_id: missingId, code: "NOT_FOUND" },
          ],
        },
      });
      expect(
        taskMutationState(await service.getWorkItem(project.code, primary.key, "full")),
      ).toEqual(beforePrimary);
      expect(durableCounts(database)).toEqual(beforeCounts);

      const corrected = await service.updateChecklistBatch(
        project.code,
        begun.session,
        "aggregate-checklist-errors",
        {
          taskKey: primary.key,
          expectedVersion: primary.version,
          items: primary.checklist.map((item) => ({
            checklistId: item.id,
            status: "DONE" as const,
            evidence: [`proof:${item.id}`],
          })),
        },
      );
      expect(corrected).toMatchObject({
        taskKey: primary.key,
        updatedCount: primary.checklist.length,
        checklist: primary.checklist.map((item) => ({ id: item.id, status: "DONE" })),
      });
      expect(durableCounts(database).idempotency).toBe(beforeCounts.idempotency + 1);
    } finally {
      service.close();
    }
  });
});

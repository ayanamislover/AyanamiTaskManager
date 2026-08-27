import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function taskWithRequiredEvidence(dataDir: string) {
  const service = await AyanamiTaskService.open({
    dataDir,
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  const project = await service.createProject({ name: "证据闸门", sourcePath: null });
  const begun = await service.begin({
    projectCode: project.code,
    agentId: "codex",
    displayName: "Codex",
    role: "PRIMARY",
  });
  const objective = await service.createObjective(project.code, begun.session, {
    title: "目标",
    description: "",
    definitionOfDone: ["完成"],
  });
  const created = await service.createWorkItems(project.code, begun.session, "plan-1", [
    {
      clientRef: "task",
      objectiveId: objective.id,
      title: "需要证据的任务",
      type: "TASK",
      priority: "NORMAL",
      status: "READY",
      checklist: [{ title: "必须留证", evidenceRequired: true }],
    },
  ]);
  const task = created.items[0]!;
  await service.patchWorkItems(project.code, begun.session, "start-1", [
    { taskKey: task.key, expectedVersion: task.version, operation: "start" },
  ]);
  const detail = await service.getWorkItem(project.code, task.key, "full");
  return { service, project, session: begun.session, task, checklistId: detail.checklist[0]!.id };
}

describe("检查项证据闸门", () => {
  it("跳过的必证检查项不再要求证据，任务因此有出路", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-evidence-skip-"));
    temporary.push(dataDir);
    const ctx = await taskWithRequiredEvidence(dataDir);
    try {
      const skipped = await ctx.service.updateChecklist(ctx.project.code, ctx.session, "skip-1", {
        checklistId: ctx.checklistId,
        expectedVersion: 0,
        status: "SKIPPED",
      });
      expect(skipped.checklist.status).toBe("SKIPPED");
      const completed = await ctx.service.patchWorkItems(ctx.project.code, ctx.session, "done-1", [
        {
          taskKey: ctx.task.key,
          expectedVersion: skipped.taskVersion,
          operation: "complete",
        },
      ]);
      expect(completed.items[0]?.status).toBe("DONE");
    } finally {
      ctx.service.close();
    }
  });

  it("未跳过且无证据时仍然拦截，勾选与完成都拒绝", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-evidence-block-"));
    temporary.push(dataDir);
    const ctx = await taskWithRequiredEvidence(dataDir);
    try {
      await expect(
        ctx.service.updateChecklist(ctx.project.code, ctx.session, "check-1", {
          checklistId: ctx.checklistId,
          expectedVersion: 0,
          status: "DONE",
          evidence: [],
        }),
      ).rejects.toMatchObject({
        code: "COMPLETION_GATE_FAILED",
        details: {
          reasons: [{ checklist_id: ctx.checklistId, code: "EVIDENCE_REQUIRED" }],
        },
      });
      const fresh = await ctx.service.getWorkItem(ctx.project.code, ctx.task.key, "core");
      await expect(
        ctx.service.patchWorkItems(ctx.project.code, ctx.session, "done-2", [
          { taskKey: ctx.task.key, expectedVersion: fresh.version, operation: "complete" },
        ]),
      ).rejects.toMatchObject({
        code: "COMPLETION_GATE_FAILED",
        details: {
          reasons: expect.arrayContaining([
            { checklist_id: ctx.checklistId, code: "CHECKLIST_INCOMPLETE" },
          ]),
        },
      });
    } finally {
      ctx.service.close();
    }
  });

  it("附上证据后勾选与完成都放行", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-evidence-pass-"));
    temporary.push(dataDir);
    const ctx = await taskWithRequiredEvidence(dataDir);
    try {
      const checked = await ctx.service.updateChecklist(ctx.project.code, ctx.session, "check-2", {
        checklistId: ctx.checklistId,
        expectedVersion: 0,
        status: "DONE",
        evidence: ["packaged smoke 11/11"],
      });
      expect(checked.checklist.evidence).toEqual(["packaged smoke 11/11"]);
      const completed = await ctx.service.patchWorkItems(ctx.project.code, ctx.session, "done-3", [
        { taskKey: ctx.task.key, expectedVersion: checked.taskVersion, operation: "complete" },
      ]);
      expect(completed.items[0]?.status).toBe("DONE");
    } finally {
      ctx.service.close();
    }
  });
});

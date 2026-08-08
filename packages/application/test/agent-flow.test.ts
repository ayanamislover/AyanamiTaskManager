import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("单 Agent 完整工作流", () => {
  it("通过同一应用服务创建项目、计划、领取、进度和完成任务", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-app-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      const project = await service.createProject({ name: "应用服务测试", sourcePath: null });
      const begun = await service.begin({
        projectCode: project.code,
        agentId: "codex",
        displayName: "Codex",
        role: "PRIMARY",
      });
      const objective = await service.createObjective(project.code, begun.session, {
        title: "交付可靠工作流",
        description: "",
        definitionOfDone: ["测试通过"],
      });
      const milestone = await service.createMilestone(project.code, begun.session, {
        objectiveId: objective.id,
        title: "核心能力",
      });
      const created = await service.createWorkItems(project.code, begun.session, "plan-1", [
        {
          clientRef: "task",
          objectiveId: objective.id,
          milestoneId: milestone.id,
          title: "完成应用服务链路",
          type: "TASK",
          priority: "HIGH",
          status: "READY",
          acceptance: ["测试通过"],
          checklist: [{ title: "测试通过", evidenceRequired: true }],
        },
      ]);
      const task = created.items[0]!;
      const claimed = await service.patchWorkItems(project.code, begun.session, "claim-1", [
        { taskKey: task.key, expectedVersion: task.version, operation: "start" },
      ]);
      expect(claimed.items[0]?.status).toBe("IN_PROGRESS");
      const detail = await service.getWorkItem(project.code, task.key, "context");
      const checked = await service.updateChecklist(project.code, begun.session, "check-1", {
        checklistId: detail.checklist[0]!.id,
        expectedVersion: 0,
        status: "DONE",
        evidence: [{ kind: "test", ref: "agent-flow.test.ts" }],
      });
      expect(checked.taskProgress).toBe(99);
      const completed = await service.patchWorkItems(project.code, begun.session, "done-1", [
        {
          taskKey: task.key,
          expectedVersion: checked.taskVersion,
          operation: "complete",
        },
      ]);
      expect(completed.items[0]?.status).toBe("DONE");
      expect((await service.brief(project.code, begun.session)).active).toBe(0);
    } finally {
      service.close();
    }
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager, ProjectRepository } from "../src/index.js";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function fixture(code: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "atm-phase-waiting-"));
  temporary.push(dataDir);
  const manager = await AyanamiDatabaseManager.open({
    dataDir,
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  const project = await manager.createProject({ name: "阶段与等待测试", sourcePath: null, code });
  const repository = new ProjectRepository(await manager.openProject(project.id));
  const session = repository.createSession({
    agentId: "phase-agent",
    displayName: "Phase Agent",
    clientKind: "test",
    role: "SUBAGENT",
  });
  const actor = { type: "AGENT" as const, id: "phase-agent", sessionId: session.id };
  const objective = repository.createObjective(actor, {
    title: "正交状态",
    description: "",
    definitionOfDone: [],
  });
  return { manager, repository, actor, objective };
}

describe("WorkItem 阶段与等待对象正交", () => {
  it("VERIFYING 等待 Agent 时保留验收阶段", async () => {
    const { manager, repository, actor, objective } = await fixture("PHASE");
    try {
      let task = repository.createWorkItems(actor, "create-verifying-wait", [
        {
          clientRef: "review",
          objectiveId: objective.id,
          title: "等待异构复核",
          type: "REVIEW",
          priority: "HIGH",
          status: "READY",
        },
      ]).items[0]!;
      task = repository.patchWorkItems(actor, "start-verifying-wait", [
        { taskKey: task.key, expectedVersion: task.version, operation: "start" },
      ]).items[0]!;
      task = repository.patchWorkItems(actor, "verify-before-wait", [
        { taskKey: task.key, expectedVersion: task.version, operation: "verify" },
      ]).items[0]!;

      const waiting = repository.patchWorkItems(actor, "wait-for-reviewer", [
        {
          taskKey: task.key,
          expectedVersion: task.version,
          operation: "wait_agent",
          waitingFor: "CLAUDE-T-0001",
        },
      ]).items[0]!;

      expect(waiting).toMatchObject({
        status: "WAITING_AGENT",
        phase: "VERIFYING",
        waitingOn: "AGENT",
        waitingFor: "CLAUDE-T-0001",
        phaseInferred: false,
      });
    } finally {
      manager.close();
    }
  });

  it("恢复等待时回到原 VERIFYING 阶段并清除等待对象", async () => {
    const { manager, repository, actor, objective } = await fixture("RESUME");
    try {
      let task = repository.createWorkItems(actor, "create-resume-wait", [
        {
          clientRef: "review",
          objectiveId: objective.id,
          title: "恢复复核任务",
          type: "REVIEW",
          priority: "HIGH",
          status: "READY",
        },
      ]).items[0]!;
      for (const [opId, operation] of [
        ["start-resume-wait", "start"],
        ["verify-resume-wait", "verify"],
      ] as const) {
        task = repository.patchWorkItems(actor, opId, [
          { taskKey: task.key, expectedVersion: task.version, operation },
        ]).items[0]!;
      }
      task = repository.patchWorkItems(actor, "pause-resume-wait", [
        {
          taskKey: task.key,
          expectedVersion: task.version,
          operation: "wait_agent",
          waitingFor: "独立复核",
        },
      ]).items[0]!;

      const resumed = repository.patchWorkItems(actor, "resume-review", [
        { taskKey: task.key, expectedVersion: task.version, operation: "reopen" },
      ]).items[0]!;

      expect(resumed).toMatchObject({
        status: "VERIFYING",
        phase: "VERIFYING",
        waitingOn: null,
        waitingFor: null,
        phaseInferred: false,
      });
      expect(repository.getSession(actor.sessionId!)).toMatchObject({
        current_work_item_id: resumed.id,
        work_state: "WORKING",
      });
    } finally {
      manager.close();
    }
  });

  it("checklist 派生进度同时解释 2/5 分母与 reported 90", async () => {
    const { manager, repository, actor, objective } = await fixture("DENOM");
    try {
      const task = repository.createWorkItems(actor, "create-progress-denominator", [
        {
          clientRef: "gated",
          objectiveId: objective.id,
          title: "五阶段门禁",
          type: "TASK",
          priority: "HIGH",
          status: "IN_PROGRESS",
          checklist: Array.from({ length: 5 }, (_, index) => ({
            title: `阶段 ${index + 1}`,
            weight: 1,
          })),
        },
      ]).items[0]!;
      const checklist = repository.getWorkItem(task.key).checklist;
      for (const [index, item] of checklist.slice(0, 2).entries()) {
        repository.updateChecklist(actor, `finish-stage-${index + 1}`, {
          checklistId: item.id,
          expectedVersion: item.version,
          status: "DONE",
        });
      }
      repository.addProgress(actor, "reported-progress-90", {
        taskKey: task.key,
        percent: 90,
        summary: "计算工作接近完成，但门禁仅完成两项",
      });

      expect(repository.getWorkItem(task.key)).toMatchObject({
        progress: 40,
        reportedProgress: 90,
        progressSource: "CHECKLIST",
        progressBreakdown: {
          computed: 40,
          reported: 90,
          source: "CHECKLIST",
          doneWeight: 2,
          totalWeight: 5,
          doneStages: 2,
          totalStages: 5,
          blocker: null,
        },
      });
    } finally {
      manager.close();
    }
  });

  it("阻塞进度同步阶段并在 progressBreakdown 解释原因", async () => {
    const { manager, repository, actor, objective } = await fixture("BLOCKWHY");
    try {
      const task = repository.createWorkItems(actor, "create-blocked-progress", [
        {
          clientRef: "blocked",
          objectiveId: objective.id,
          title: "等待外部授权",
          type: "TASK",
          priority: "CRITICAL",
          status: "IN_PROGRESS",
        },
      ]).items[0]!;
      repository.addProgress(actor, "block-with-reason", {
        taskKey: task.key,
        percent: 70,
        summary: "本地实现完成，部署需要授权",
        blocker: "等待生产部署授权",
      });

      expect(repository.getWorkItem(task.key)).toMatchObject({
        status: "BLOCKED",
        phase: "BLOCKED",
        waitingOn: null,
        waitingFor: null,
        progressBreakdown: { blocker: "等待生产部署授权" },
      });
    } finally {
      manager.close();
    }
  });
});

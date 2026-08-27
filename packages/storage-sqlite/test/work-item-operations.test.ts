import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager, ProjectRepository } from "../src/index.js";
import { captureAtmError } from "./typed-error-test-helpers.js";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  }
});

async function fixture(code: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "atm-work-item-operations-"));
  temporary.push(dataDir);
  const manager = await AyanamiDatabaseManager.open({
    dataDir,
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  const project = await manager.createProject({ name: "操作注册表测试", sourcePath: null, code });
  const repository = new ProjectRepository(await manager.openProject(project.id));
  const session = repository.createSession({
    agentId: "operation-agent",
    displayName: "Operation Agent",
    clientKind: "test",
    role: "SUBAGENT",
  });
  const actor = { type: "AGENT" as const, id: "operation-agent", sessionId: session.id };
  const objective = repository.createObjective(actor, {
    title: "操作语义",
    description: "",
    definitionOfDone: [],
  });
  return { manager, repository, session, actor, objective };
}

describe("canonical WorkItem operation registry", () => {
  it("progress blocker 不能绕过 block 的来源状态合法性，失败保持零写", async () => {
    const { manager, repository, actor, objective } = await fixture("OPBLOCK");
    try {
      let task = repository.createWorkItems(actor, "create-done", [
        {
          clientRef: "done",
          objectiveId: objective.id,
          title: "已经完成",
          type: "TASK",
          priority: "NORMAL",
          status: "READY",
        },
      ]).items[0]!;
      task = repository.patchWorkItems(actor, "start-done", [
        { taskKey: task.key, expectedVersion: task.version, operation: "start" },
      ]).items[0]!;
      task = repository.patchWorkItems(actor, "complete-done", [
        { taskKey: task.key, expectedVersion: task.version, operation: "complete" },
      ]).items[0]!;
      const sequenceBefore = repository.delta(0, 100).currentSequence;

      expect(
        captureAtmError(() =>
          repository.addProgress(actor, "invalid-progress-block", {
            taskKey: task.key,
            percent: 100,
            summary: "完成后不应重新阻塞",
            blocker: "伪造阻塞",
          }),
        ),
      ).toMatchObject({
        code: "INVALID_TRANSITION",
        details: expect.objectContaining({
          operation: "block",
          current_status: "DONE",
          requested_status: "BLOCKED",
        }),
      });
      expect(repository.getWorkItem(task.key)).toMatchObject({
        status: "DONE",
        version: task.version,
        blockedReason: null,
      });
      expect(repository.delta(0, 100).currentSequence).toBe(sequenceBefore);
    } finally {
      manager.close();
    }
  });

  it("Session end/force-close 只把 CLAIMED 退回 READY，执行态仅清 claim", async () => {
    for (const [code, close] of [
      ["OPEND", "end"],
      ["OPFORCE", "force"],
    ] as const) {
      const { manager, repository, session, actor, objective } = await fixture(code);
      try {
        const created = repository.createWorkItems(actor, `create-${close}-claims`, [
          {
            clientRef: "claimed",
            objectiveId: objective.id,
            title: "只领取",
            type: "TASK",
            priority: "NORMAL",
            status: "READY",
          },
          {
            clientRef: "running",
            objectiveId: objective.id,
            title: "执行中",
            type: "TASK",
            priority: "NORMAL",
            status: "READY",
          },
        ]).items;
        const claimed = repository.patchWorkItems(actor, `claim-${close}`, [
          {
            taskKey: created[0]!.key,
            expectedVersion: created[0]!.version,
            operation: "claim",
          },
        ]).items[0]!;
        const running = repository.patchWorkItems(actor, `start-${close}`, [
          {
            taskKey: created[1]!.key,
            expectedVersion: created[1]!.version,
            operation: "start",
          },
        ]).items[0]!;

        if (close === "end") {
          repository.endSession(actor, "end-with-claims", {
            outcome: "completed",
            summary: "结束 Session",
            releaseClaims: true,
          });
        } else {
          repository.forceCloseSession(session.id, true);
        }

        expect(repository.getWorkItem(claimed.key)).toMatchObject({
          status: "READY",
          claimedBySessionId: null,
        });
        expect(repository.getWorkItem(running.key)).toMatchObject({
          status: "IN_PROGRESS",
          claimedBySessionId: null,
          assigneeAgentId: actor.id,
        });
      } finally {
        manager.close();
      }
    }
  });

  it("Session end 原子返回全部 521 个被释放 WorkItem，不受列表上限影响", async () => {
    const { manager, repository, actor, objective } = await fixture("OPENDSCALE");
    try {
      const created = [];
      for (let offset = 0; offset < 521; offset += 50) {
        const batchSize = Math.min(50, 521 - offset);
        created.push(
          ...repository.createWorkItems(
            actor,
            `create-scale-${offset}`,
            Array.from({ length: batchSize }, (_, index) => ({
              clientRef: `scale-${offset + index}`,
              objectiveId: objective.id,
              title: `规模释放 ${offset + index + 1}`,
              type: "TASK" as const,
              priority: "NORMAL" as const,
              status: "READY" as const,
            })),
          ).items,
        );
      }
      for (let offset = 0; offset < created.length; offset += 50) {
        repository.patchWorkItems(
          actor,
          `claim-scale-${offset}`,
          created.slice(offset, offset + 50).map((task) => ({
            taskKey: task.key,
            expectedVersion: task.version,
            operation: "claim" as const,
          })),
        );
      }

      const ended = repository.endSession(actor, "end-scale", {
        outcome: "completed",
        summary: "释放大规模 claims",
        releaseClaims: true,
      });

      expect(ended.releasedItems).toHaveLength(521);
      expect(ended.releasedItems.map((item) => item.key)).toEqual(created.map((item) => item.key));
      expect(ended.releasedItems.every((item) => item.version === 3)).toBe(true);
      for (const task of created) {
        expect(repository.getWorkItem(task.key)).toMatchObject({
          status: "READY",
          claimedBySessionId: null,
          version: 3,
        });
      }
    } finally {
      manager.close();
    }
  });
});

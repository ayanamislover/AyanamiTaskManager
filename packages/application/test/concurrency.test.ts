import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("并发与幂等", () => {
  it("两个 session 同时领取只允许一个成功，同一 op 重试不重复事件", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-concurrency-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      const project = await service.createProject({ name: "并发测试", sourcePath: null });
      const left = await service.begin({
        projectCode: project.code,
        agentId: "left",
        role: "PRIMARY",
      });
      const right = await service.begin({
        projectCode: project.code,
        agentId: "right",
        role: "SUBAGENT",
      });
      const objective = await service.createObjective(project.code, left.session, {
        title: "并发一致性",
        description: "",
        definitionOfDone: [],
      });
      const milestone = await service.createMilestone(project.code, left.session, {
        objectiveId: objective.id,
        title: "领取",
      });
      const created = await service.createWorkItems(project.code, left.session, "create", [
        {
          clientRef: "claim",
          objectiveId: objective.id,
          milestoneId: milestone.id,
          title: "只能领取一次",
          type: "TASK",
          priority: "NORMAL",
          status: "READY",
        },
      ]);
      const task = created.items[0]!;
      const attempts = await Promise.allSettled([
        service.patchWorkItems(project.code, left.session, "claim", [
          { taskKey: task.key, expectedVersion: task.version, operation: "claim" },
        ]),
        service.patchWorkItems(project.code, right.session, "claim", [
          { taskKey: task.key, expectedVersion: task.version, operation: "claim" },
        ]),
      ]);
      expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
      expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);

      const winner = attempts.find((attempt) => attempt.status === "fulfilled")!;
      const winningSession = winner.value.items[0]!.claimedBySessionId!;
      const replay = await service.patchWorkItems(project.code, winningSession, "claim", [
        { taskKey: task.key, expectedVersion: task.version, operation: "claim" },
      ]);
      expect(replay.sequence).toBe(winner.value.sequence);
    } finally {
      service.close();
    }
  });
});

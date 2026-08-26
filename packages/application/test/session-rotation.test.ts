import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Session retirement 与低成本恢复", () => {
  it("在 application actor 检查前回放旧 Session 写入，并沿显式 successor 保持幂等", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-rotation-replay-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      await service.createProject({ name: "回放测试", sourcePath: null, code: "REPLAY" });
      const first = await service.begin({
        projectCode: "REPLAY",
        mode: "project",
        agentId: "codex",
        clientKind: "test",
      });
      const input = {
        kind: "FACT",
        title: "响应可能丢失",
        summary: "同一 op 必须只落一条记录",
        detail: "application 不得先用 SESSION_CLOSED 拒绝",
      };
      const created = await service.createRecord(
        "REPLAY",
        String(first.session),
        "lost-record",
        input,
      );
      const endInput = {
        outcome: "retired" as const,
        summary: "切换 Session",
        next: ["继续"],
        releaseClaims: true,
        retirementReason: "context rotation",
      };
      const ended = await service.end("REPLAY", String(first.session), "lost-end", endInput);
      const replayed = await service.createRecord(
        "REPLAY",
        String(first.session),
        "lost-record",
        input,
      );
      expect(replayed).toMatchObject({ key: created.key, opId: "lost-record" });
      expect(await service.listRecords("REPLAY")).toHaveLength(1);
      expect(
        await service.end("REPLAY", String(first.session), "lost-end", endInput),
      ).toMatchObject({ seq: ended.seq, opId: "lost-end" });

      const successor = await service.begin({
        projectCode: "REPLAY",
        mode: "project",
        agentId: "codex",
        clientKind: "test",
        resume: true,
        predecessorSessionId: String(first.session),
      });
      expect(
        await service.createRecord("REPLAY", String(successor.session), "lost-record", input),
      ).toMatchObject({ key: created.key, opId: "lost-record" });
      await expect(
        service.createRecord("REPLAY", String(successor.session), "lost-record", {
          ...input,
          summary: "相同 op 的不同载荷必须冲突",
        }),
      ).rejects.toThrow(/IDEMPOTENCY_CONFLICT/u);
      expect(await service.listRecords("REPLAY")).toHaveLength(1);
    } finally {
      service.close();
    }
  });

  it("同一 Agent successor 恢复当前任务、handoff 和 USER 约束，且不误完成任务", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-rotation-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      await service.createProject({ name: "轮换测试", sourcePath: null, code: "ROT" });
      const objective = await service.createObjectiveAsUser("ROT", "objective-1", {
        title: "稳定交接",
        description: "",
        definitionOfDone: [],
      });
      const created = await service.createWorkItemsAsUser("ROT", "task-1", [
        {
          clientRef: "rotation",
          objectiveId: objective.id,
          title: "完成 successor 恢复",
          description: "长 Session 退役后继续",
          type: "TASK",
          priority: "HIGH",
          status: "READY",
          acceptance: ["恢复当前任务", "保留用户约束"],
          checklist: [],
          verificationRequired: false,
        },
      ]);
      const task = created.items[0]!;
      const first = await service.begin({
        projectCode: "ROT",
        mode: "project",
        agentId: "codex",
        clientKind: "test",
      });
      const started = await service.patchWorkItems("ROT", String(first.session), "start-1", [
        {
          taskKey: task.key,
          expectedVersion: task.version,
          operation: "start",
          takeoverStale: false,
        },
      ]);
      await service.createRecordAsUser("ROT", "constraint-1", {
        kind: "CONSTRAINT",
        title: "用户约束",
        summary: "禁止重新审计已完成阶段",
        detail: "只做增量实现",
        importance: "HIGH",
        scope: "PROJECT",
      });
      const blocked = await service.patchWorkItems("ROT", String(first.session), "block-1", [
        {
          taskKey: task.key,
          expectedVersion: started.items[0]!.version,
          operation: "block",
          blockedReason: "等待恢复测试",
          takeoverStale: false,
        },
      ]);
      const ended = await service.end("ROT", String(first.session), "retire-1", {
        outcome: "retired",
        summary: "上下文已退役，任务继续",
        next: ["完成验证"],
        releaseClaims: true,
        retirementReason: "compact 频率升高",
      });
      expect(ended.handoffs).toBe(1);

      const successor = await service.begin({
        projectCode: "ROT",
        mode: "project",
        agentId: "codex",
        clientKind: "test",
        resume: true,
        predecessorSessionId: String(first.session),
        maxChars: 1200,
      });
      expect(successor.currentTask).toMatchObject({
        key: task.key,
        status: "BLOCKED",
        version: expect.any(Number),
        acceptance: ["恢复当前任务", "保留用户约束"],
        blockedReason: "等待恢复测试",
        claim: null,
      });
      expect(successor.currentTask.version).toBeGreaterThan(blocked.items[0]!.version);
      expect(successor.handoff).toMatchObject({
        summary: "上下文已退役，任务继续",
        nextAction: "完成验证",
      });
      expect(successor.next).toContain("完成验证");
      expect(successor.records).toContainEqual(
        expect.objectContaining({
          kind: "CONSTRAINT",
          summary: "禁止重新审计已完成阶段",
          source_type: "USER",
        }),
      );
      expect(JSON.stringify(successor).length).toBeLessThanOrEqual(1200);
      expect((await service.getWorkItem("ROT", task.key)).status).toBe("BLOCKED");
    } finally {
      service.close();
    }
  });

  it("默认 brief 排除已取代记录和大量历史噪音", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-rotation-noise-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      await service.createProject({ name: "噪音测试", sourcePath: null, code: "NOISE" });
      await service.createRecordAsUser("NOISE", "constraint-old", {
        kind: "CONSTRAINT",
        title: "旧约束",
        summary: "使用旧方案",
        detail: "",
        importance: "HIGH",
        scope: "PROJECT",
      });
      const old = (await service.listRecords("NOISE")).find((record) => record.title === "旧约束")!;
      await service.createRecordAsUser("NOISE", "constraint-new", {
        kind: "CONSTRAINT",
        title: "新约束",
        summary: "只使用新方案",
        detail: "",
        importance: "HIGH",
        scope: "PROJECT",
        supersedes: old.id,
      });
      for (let index = 0; index < 40; index += 1) {
        await service.createRecordAsUser("NOISE", `noise-${index}`, {
          kind: "REFERENCE",
          title: `历史 ${index}`,
          summary: `可以重新获取的历史噪音 ${index}`,
          detail: "x".repeat(100),
          importance: "LOW",
          scope: "PROJECT",
        });
      }
      const brief = await service.brief("NOISE", null, 1200);
      expect(JSON.stringify(brief)).not.toContain("使用旧方案");
      expect(JSON.stringify(brief)).toContain("只使用新方案");
      expect(JSON.stringify(brief)).not.toContain("历史 39");
      expect(JSON.stringify(brief).length).toBeLessThanOrEqual(1200);
    } finally {
      service.close();
    }
  });
});

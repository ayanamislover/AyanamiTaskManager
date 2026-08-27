import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("自动维护与崩溃恢复", () => {
  it("按默认 5 分钟边界关闭空闲项目数据库", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-lru-policy-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      await service.createProject({ name: "LRU 策略", sourcePath: null, code: "LRU" });
      const openedBefore = Date.now();
      await service.databases.openProject("LRU");
      const openedAfter = Date.now();
      expect(service.databases.closeIdleProjects(undefined, openedBefore + 5 * 60_000 - 1)).toBe(0);
      expect(service.databases.closeIdleProjects(undefined, openedAfter + 5 * 60_000)).toBe(1);
    } finally {
      service.close();
    }
  });

  it("归档、PRE_TRASH 备份、垃圾箱与恢复形成完整可逆链路", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-project-lifecycle-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      await service.createProject({ name: "生命周期", sourcePath: null, code: "LIFE" });
      await service.archiveProject("LIFE");
      expect(service.databases.getProject("LIFE").lifecycle).toBe("ARCHIVED");
      expect(service.listBackups("LIFE").map((backup) => backup.reason)).toContain("PRE_ARCHIVE");

      await service.trashProject("LIFE");
      expect(service.databases.getProject("LIFE").lifecycle).toBe("TRASHED");
      expect(service.listBackups("LIFE").map((backup) => backup.reason)).toContain("PRE_TRASH");

      service.restoreProject("LIFE");
      expect(service.databases.getProject("LIFE").lifecycle).toBe("ACTIVE");
      expect((await service.databases.openProject("LIFE")).schemaVersion).toBe(12);
    } finally {
      service.close();
    }
  });

  it("每日维护幂等备份 Registry 和活动项目，关闭策略后不写入", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-maintenance-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      await service.createProject({ name: "自动备份", sourcePath: null, code: "AUTO" });
      await service.databases.openProject("AUTO");
      expect(service.databases.closeIdleProjects(0, Date.now() + 1)).toBe(1);
      const first = await service.runMaintenance(new Date("2026-08-07T10:00:00.000Z"));
      expect(first).toMatchObject({ skipped: false, dailyCreated: 2, weeklyCreated: 2 });
      const count = service.listBackups().length;
      expect(
        (await service.runMaintenance(new Date("2026-08-07T18:00:00.000Z"))).dailyCreated,
      ).toBe(0);
      expect(service.listBackups()).toHaveLength(count);
      service.setSetting("backup.policy", { enabled: false, dailyKeep: 7, weeklyKeep: 4 });
      expect(await service.runMaintenance(new Date("2026-08-08T10:00:00.000Z"))).toMatchObject({
        skipped: true,
      });
      expect(service.listBackups()).toHaveLength(count);
    } finally {
      service.close();
    }
  });

  it("重启后关闭失联 Session，保留 stale claim 供显式接管，并清理中断备份临时文件", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-recovery-"));
    temporary.push(dataDir);
    let service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    await service.createProject({ name: "恢复测试", sourcePath: null, code: "RECV" });
    const objective = await service.createObjectiveAsUser("RECV", "objective-1", {
      title: "恢复",
      description: "",
      definitionOfDone: [],
    });
    const task = (
      await service.createWorkItemsAsUser("RECV", "task-1", [
        {
          clientRef: "recover",
          objectiveId: objective.id,
          title: "接管过期任务",
          description: "",
          type: "TASK",
          priority: "HIGH",
          status: "READY",
          acceptance: [],
          checklist: [],
          verificationRequired: false,
        },
      ])
    ).items[0]!;
    const begun = await service.begin({
      projectCode: "RECV",
      mode: "project",
      agentId: "lost-agent",
      clientKind: "test",
    });
    await service.patchWorkItems("RECV", String(begun.session), "claim-1", [
      {
        taskKey: task.key,
        expectedVersion: task.version,
        operation: "claim",
        takeoverStale: false,
      },
    ]);
    const database = await service.databases.openProject("RECV");
    database.sqlite
      .prepare(
        "UPDATE agent_sessions SET heartbeat_at = '2000-01-01T00:00:00.000Z', updated_at = '2000-01-01T00:00:00.000Z'",
      )
      .run();
    database.sqlite
      .prepare("UPDATE work_items SET claim_lease_until = '2000-01-01T00:00:00.000Z'")
      .run();
    const temporaryBackup = join(dirname(database.path), "backups", "interrupted.sqlite.tmp");
    mkdirSync(dirname(temporaryBackup), { recursive: true });
    writeFileSync(temporaryBackup, "partial", "utf8");
    service.close();

    service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      const reopened = await service.databases.openProject("RECV");
      const session = reopened.sqlite
        .prepare("SELECT connection_state FROM agent_sessions WHERE id = ?")
        .get(String(begun.session)) as { connection_state: string };
      expect(session.connection_state).toBe("CLOSED");
      expect(await service.getWorkItem("RECV", task.key)).toMatchObject({
        claimedBySessionId: String(begun.session),
      });
      expect((service.overview().projects as any[])[0]).toMatchObject({
        stale_claim_count: 1,
        active_agent_count: 0,
      });
      expect(existsSync(temporaryBackup)).toBe(false);
      const abnormal = await service.begin({
        projectCode: "RECV",
        mode: "project",
        agentId: "abnormal-agent",
        clientKind: "test",
      });
      await service.forceCloseSessionAsUser("RECV", String(abnormal.session), true);
      expect(
        reopened.sqlite
          .prepare("SELECT connection_state FROM agent_sessions WHERE id = ?")
          .get(String(abnormal.session)),
      ).toMatchObject({ connection_state: "CLOSED" });
    } finally {
      service.close();
    }
  });
});

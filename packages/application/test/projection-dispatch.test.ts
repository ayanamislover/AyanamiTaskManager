import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectRepository } from "@ayanami-task/storage-sqlite";
import { AyanamiTaskService } from "../src/index.js";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe("权威写模型与 Registry 投影分离", () => {
  it("投影失败返回 DEFERRED 并持久保留待投递状态，关闭备份后维护仍会追平", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-projection-dispatch-"));
    temporary.push(dataDir);
    let service: AyanamiTaskService | null = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });

    try {
      const project = await service.createProject({
        name: "投影可靠性",
        sourcePath: null,
        code: "PRJ",
      });
      service.setSetting("backup.policy", { enabled: false, dailyKeep: 7, weeklyKeep: 4 });
      service.databases.registry.sqlite.exec(`
        CREATE TRIGGER fail_registry_summary_projection
        BEFORE UPDATE OF project_sequence ON project_summary_cache
        WHEN NEW.project_id = '${project.id}'
        BEGIN
          SELECT RAISE(ABORT, 'injected registry projection failure');
        END;
      `);

      const receipt = await service.createObjectiveAsUser(project.code, "projection-failure", {
        title: "权威写入必须提交",
        description: "Registry 故障不能回滚项目库",
        definitionOfDone: [],
      });

      expect(receipt).toMatchObject({
        title: "权威写入必须提交",
        projection: {
          status: "DEFERRED",
          sourceSeq: receipt.sequence,
          projectedSeq: 0,
          retryScheduled: true,
        },
      });

      const projectDatabase = await service.databases.openProject(project.id);
      expect(
        projectDatabase.sqlite.prepare("SELECT COUNT(*) AS count FROM objectives").get(),
      ).toMatchObject({ count: 1 });
      expect(
        projectDatabase.sqlite
          .prepare("SELECT COUNT(*) AS count FROM outbox WHERE delivered_at IS NULL")
          .get(),
      ).toMatchObject({ count: 1 });

      const failedState = service.databases.registry.sqlite
        .prepare(
          `SELECT source_sequence, projected_sequence, status, last_error, retry_count
           FROM project_projection_state WHERE project_id = ?`,
        )
        .get(project.id) as
        | {
            source_sequence: number;
            projected_sequence: number;
            status: string;
            last_error: string | null;
            retry_count: number;
          }
        | undefined;
      expect(failedState).toMatchObject({
        source_sequence: receipt.sequence,
        projected_sequence: 0,
        status: "DEFERRED",
        last_error: expect.stringContaining("injected registry projection failure"),
        retry_count: expect.any(Number),
      });
      expect(failedState!.retry_count).toBeGreaterThanOrEqual(1);

      service.close();
      service = await AyanamiTaskService.open({
        dataDir,
        migrationsRoot: resolve(process.cwd(), "migrations"),
      });
      expect(
        service.databases.registry.sqlite
          .prepare("SELECT status FROM project_projection_state WHERE project_id = ?")
          .get(project.id),
      ).toMatchObject({ status: "DEFERRED" });

      service.databases.registry.sqlite.exec("DROP TRIGGER fail_registry_summary_projection");
      await service.runMaintenance(new Date("2026-08-27T12:00:00.000Z"));

      const recoveredState = service.databases.registry.sqlite
        .prepare(
          `SELECT source_sequence, projected_sequence, status, last_error, retry_count
           FROM project_projection_state WHERE project_id = ?`,
        )
        .get(project.id) as {
        source_sequence: number;
        projected_sequence: number;
        status: string;
        last_error: string | null;
        retry_count: number;
      };
      expect(recoveredState).toMatchObject({
        source_sequence: receipt.sequence,
        projected_sequence: receipt.sequence,
        status: "APPLIED",
        last_error: null,
      });
      expect(recoveredState.retry_count).toBeGreaterThanOrEqual(1);
      expect(
        (await service.databases.openProject(project.id)).sqlite
          .prepare("SELECT COUNT(*) AS count FROM outbox WHERE delivered_at IS NULL")
          .get(),
      ).toMatchObject({ count: 0 });
      expect(
        (service.overview().projects as Array<Record<string, unknown>>).find(
          (candidate) => candidate.code === project.code,
        ),
      ).toMatchObject({ project_sequence: receipt.sequence });
    } finally {
      service?.close();
    }
  });

  it("维护逐项目隔离投影失败，A 失败不阻断 B 追平", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-projection-isolation-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });

    try {
      const projectA = await service.createProject({
        name: "Projection failure A",
        sourcePath: null,
        code: "PRA",
      });
      const projectB = await service.createProject({
        name: "Projection success B",
        sourcePath: null,
        code: "PRB",
      });
      const actor = { type: "SYSTEM" as const, id: "maintenance-isolation", sessionId: null };
      for (const project of [projectA, projectB]) {
        const repository = new ProjectRepository(await service.databases.openProject(project.id));
        repository.createObjective(
          actor,
          { title: `${project.code} pending objective`, description: "", definitionOfDone: [] },
          `${project.code}-pending-objective`,
        );
      }
      service.setSetting("backup.policy", { enabled: false, dailyKeep: 7, weeklyKeep: 4 });
      service.databases.registry.sqlite.exec(`
        CREATE TRIGGER fail_project_a_projection
        BEFORE UPDATE OF project_sequence ON project_summary_cache
        WHEN NEW.project_id = '${projectA.id}'
        BEGIN
          SELECT RAISE(ABORT, 'injected project A projection failure');
        END;
      `);

      const maintenance = await service.runMaintenance(new Date("2026-08-27T14:00:00.000Z"));
      expect(maintenance).toMatchObject({ skipped: true, recoveredProjects: 1 });
      expect(maintenance.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            scope: "PROJECTION",
            project: "PRA",
            message: expect.stringContaining("injected project A projection failure"),
          }),
        ]),
      );
      expect(
        service.databases.registry.sqlite
          .prepare("SELECT status FROM project_projection_state WHERE project_id = ?")
          .get(projectA.id),
      ).toEqual({ status: "DEFERRED" });
      expect(
        service.databases.registry.sqlite
          .prepare("SELECT status FROM project_projection_state WHERE project_id = ?")
          .get(projectB.id),
      ).toEqual({ status: "APPLIED" });
      expect(
        (await service.databases.openProject(projectA.id)).sqlite
          .prepare("SELECT attempts, last_error FROM outbox WHERE delivered_at IS NULL")
          .get(),
      ).toMatchObject({
        attempts: 1,
        last_error: expect.stringContaining("injected project A projection failure"),
      });
      expect(
        (await service.databases.openProject(projectB.id)).sqlite
          .prepare("SELECT COUNT(*) AS count FROM outbox WHERE delivered_at IS NULL")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      service.close();
    }
  });
});

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

describe("manual projection reconcile", () => {
  it("treats DEFERRED as a typed success, isolates projects and can recover the failed project", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-projection-reconcile-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });

    try {
      const projectA = await service.createProject({
        name: "Projection A",
        sourcePath: null,
        code: "PRECA",
      });
      const projectB = await service.createProject({
        name: "Projection B",
        sourcePath: null,
        code: "PRECB",
      });
      const actor = { type: "SYSTEM" as const, id: "manual-reconcile", sessionId: null };
      for (const project of [projectA, projectB]) {
        new ProjectRepository(await service.databases.openProject(project.id)).createObjective(
          actor,
          { title: `${project.code} pending`, description: "", definitionOfDone: [] },
          `${project.code}-pending`,
        );
      }
      service.databases.registry.sqlite.exec(`
        CREATE TRIGGER fail_manual_projection_a
        BEFORE UPDATE OF project_sequence ON project_summary_cache
        WHEN NEW.project_id = '${projectA.id}'
        BEGIN
          SELECT RAISE(ABORT, 'injected manual projection failure');
        END;
      `);

      await expect(service.reconcileProjection(projectA.code)).resolves.toMatchObject({
        ok: true,
        project: { id: projectA.id, code: "PRECA" },
        projection: {
          status: "DEFERRED",
          retryScheduled: true,
          lastError: expect.stringContaining("injected manual projection failure"),
        },
      });

      await expect(service.reconcileProjections()).resolves.toMatchObject({
        ok: true,
        attempted: 2,
        applied: 1,
        deferred: 1,
        failed: 0,
        results: [
          expect.objectContaining({ project: expect.objectContaining({ code: "PRECA" }) }),
          expect.objectContaining({
            project: expect.objectContaining({ code: "PRECB" }),
            projection: expect.objectContaining({ status: "APPLIED" }),
          }),
        ],
        failures: [],
      });

      service.databases.registry.sqlite.exec("DROP TRIGGER fail_manual_projection_a");
      await expect(service.reconcileProjection(projectA.code)).resolves.toMatchObject({
        ok: true,
        project: { code: "PRECA" },
        projection: { status: "APPLIED", retryScheduled: false, lastError: null, lag: 0 },
      });
    } finally {
      service.close();
    }
  });
});

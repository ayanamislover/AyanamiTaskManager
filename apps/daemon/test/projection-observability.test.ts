import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "@ayanami-task/application";
import { ProjectRepository } from "@ayanami-task/storage-sqlite";
import { buildAyanamiServer } from "../src/index.js";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe("projection observability REST API", () => {
  it("exposes stable status/overview facts and typed manual recovery without failing readiness", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-projection-api-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    const projectA = await service.createProject({
      name: "Projection REST A",
      sourcePath: null,
      code: "PAPIA",
    });
    const projectB = await service.createProject({
      name: "Projection REST B",
      sourcePath: null,
      code: "PAPIB",
    });
    const actor = { type: "SYSTEM" as const, id: "projection-rest", sessionId: null };
    for (const project of [projectA, projectB]) {
      new ProjectRepository(await service.databases.openProject(project.id)).createObjective(
        actor,
        { title: `${project.code} pending`, description: "", definitionOfDone: [] },
        `${project.code}-pending`,
      );
    }
    service.databases.registry.sqlite.exec(`
      CREATE TRIGGER fail_projection_rest_a
      BEFORE UPDATE OF project_sequence ON project_summary_cache
      WHEN NEW.project_id = '${projectA.id}'
      BEGIN
        SELECT RAISE(ABORT, 'injected REST projection failure');
      END;
    `);
    const app = await buildAyanamiServer({ service, token: "projection-token" });
    const headers = { authorization: "Bearer projection-token" };

    try {
      const deferred = await app.inject({
        method: "POST",
        url: "/api/v1/projects/PAPIA/projection/reconcile",
        headers,
      });
      expect(deferred.statusCode).toBe(200);
      expect(deferred.json()).toMatchObject({
        ok: true,
        project: { code: "PAPIA" },
        projection: { status: "DEFERRED", retryScheduled: true, lag: 1 },
      });

      const status = await app.inject({ method: "GET", url: "/api/v1/system/status", headers });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({
        ok: true,
        projectionSummary: {
          status: "DEFERRED",
          appliedCount: 1,
          deferredCount: 1,
          missingCount: 0,
          retryScheduledCount: 1,
          maxLag: 1,
        },
        projectionFailures: [
          expect.objectContaining({
            project: expect.objectContaining({ code: "PAPIA" }),
            reason: "DEFERRED",
            lag: 1,
          }),
        ],
      });

      const overview = await app.inject({ method: "GET", url: "/api/v1/overview", headers });
      expect(overview.json()).toMatchObject({
        projectionSummary: { status: "DEFERRED", deferredCount: 1 },
        projectionFailures: [
          expect.objectContaining({ project: expect.objectContaining({ code: "PAPIA" }) }),
        ],
        projects: expect.arrayContaining([
          expect.objectContaining({
            code: "PAPIA",
            projection: expect.objectContaining({
              status: "DEFERRED",
              lag: 1,
              project: expect.objectContaining({ code: "PAPIA" }),
            }),
          }),
        ]),
      });

      const batch = await app.inject({
        method: "POST",
        url: "/api/v1/system/projections/reconcile",
        headers,
      });
      expect(batch.statusCode).toBe(200);
      expect(batch.json()).toMatchObject({
        ok: true,
        attempted: 2,
        applied: 1,
        deferred: 1,
        failed: 0,
      });

      const missing = await app.inject({
        method: "POST",
        url: "/api/v1/projects/NOTHERE/projection/reconcile",
        headers,
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ error: { code: "PROJECT_NOT_FOUND" } });

      service.databases.registry.sqlite.exec("DROP TRIGGER fail_projection_rest_a");
      const recovered = await app.inject({
        method: "POST",
        url: "/api/v1/projects/PAPIA/projection/reconcile",
        headers,
      });
      expect(recovered.json()).toMatchObject({
        ok: true,
        projection: { status: "APPLIED", retryScheduled: false, lag: 0 },
      });
    } finally {
      await app.close();
      service.close();
    }
  });
});

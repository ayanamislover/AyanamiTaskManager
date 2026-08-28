import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager } from "../src/manager.js";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe("projection status read model", () => {
  it("uses one public mapping for state, list, summary and doctor without hiding inverted lag", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-projection-status-"));
    temporary.push(dataDir);
    const manager = await AyanamiDatabaseManager.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });

    try {
      const project = await manager.createProject({
        name: "Projection status",
        sourcePath: null,
        code: "PSTAT",
      });
      await manager.createProject({
        name: "Healthy projection",
        sourcePath: null,
        code: "PZERO",
      });
      const healthy = manager.projectionState("PZERO");
      manager.registry.sqlite.pragma("ignore_check_constraints = ON");
      manager.registry.sqlite
        .prepare(
          `UPDATE project_projection_state
           SET source_sequence = 4, projected_sequence = 7, status = 'DEFERRED',
               last_error = ?, retry_count = 3, updated_at = ?
           WHERE project_id = ?`,
        )
        .run("x".repeat(3_000), "2026-08-28T01:02:03.000Z", project.id);
      manager.registry.sqlite.pragma("ignore_check_constraints = OFF");

      const expected = {
        project: {
          id: project.id,
          code: "PSTAT",
          name: "Projection status",
          lifecycle: "ACTIVE",
        },
        status: "DEFERRED",
        sourceSeq: 4,
        projectedSeq: 7,
        lag: -3,
        retryScheduled: true,
        lastError: "x".repeat(2_000),
        retryCount: 3,
        updatedAt: "2026-08-28T01:02:03.000Z",
      };

      expect(manager.projectionState("PSTAT")).toEqual(expected);
      expect(manager.listProjectionStates()).toEqual([expected, healthy]);
      expect(manager.projectionSummary()).toEqual({
        status: "DEFERRED",
        total: 2,
        appliedCount: 1,
        deferredCount: 1,
        missingCount: 0,
        retryScheduledCount: 1,
        lagging: 1,
        maxLag: -3,
        totalLag: -3,
      });
      const doctor = await manager.doctor();
      expect(doctor).toMatchObject({
        projectionSummary: {
          status: "DEFERRED",
          total: 2,
          appliedCount: 1,
          deferredCount: 1,
          missingCount: 0,
          retryScheduledCount: 1,
          lagging: 1,
          maxLag: -3,
          totalLag: -3,
        },
        projectionFailures: [
          { project: expected.project, reason: "INVERTED", lag: -3, state: expected },
        ],
      });
      expect(doctor.projects).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "PSTAT", projection: expected })]),
      );
    } finally {
      manager.close();
    }
  });

  it("counts missing active state without letting trashed projects create alerts", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-projection-missing-"));
    temporary.push(dataDir);
    const manager = await AyanamiDatabaseManager.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });

    try {
      const active = await manager.createProject({
        name: "Missing active projection",
        sourcePath: null,
        code: "PMSA",
      });
      const trashed = await manager.createProject({
        name: "Missing trashed projection",
        sourcePath: null,
        code: "PMST",
      });
      manager.setProjectLifecycle(trashed.code, "TRASHED");
      manager.registry.sqlite
        .prepare("DELETE FROM project_projection_state WHERE project_id IN (?, ?)")
        .run(active.id, trashed.id);

      expect(manager.projectionSummary()).toMatchObject({
        status: "DEFERRED",
        total: 1,
        appliedCount: 0,
        deferredCount: 0,
        missingCount: 1,
        retryScheduledCount: 0,
      });
      expect(manager.projectionFailures()).toEqual([
        expect.objectContaining({
          project: expect.objectContaining({ code: "PMSA" }),
          reason: "MISSING",
          state: null,
        }),
      ]);
      await expect(manager.doctor()).resolves.toMatchObject({
        projectionSummary: { total: 1, missingCount: 1 },
        projectionFailures: [
          expect.objectContaining({ project: expect.objectContaining({ code: "PMSA" }) }),
        ],
        projects: expect.arrayContaining([
          expect.objectContaining({ code: "PMSA", projection: null }),
          expect.objectContaining({ code: "PMST", projection: null }),
        ]),
      });
    } finally {
      manager.close();
    }
  });
});

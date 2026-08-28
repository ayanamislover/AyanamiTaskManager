import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "../../application/src/index.js";
import { buildAyanamiServer } from "../../../apps/daemon/src/index.js";
import {
  AyanamiClient,
  AyanamiClientError,
  type ProjectionBatchReceipt,
  type ProjectionReconcileReceipt,
  type SystemStatus,
} from "../src/index.js";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

describe("projection client", () => {
  it("uses typed project/system reconcile APIs and preserves typed 404", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "atm-projection-client-"));
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: join(process.cwd(), "migrations"),
    });
    const app = await buildAyanamiServer({ service, token: "projection-client-token" });
    await app.listen({ host: "127.0.0.1", port: 0 });
    cleanup.push(async () => {
      await app.close();
      service.close();
      await rm(dataDir, { recursive: true, force: true });
    });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("测试服务未监听 TCP");
    const client = new AyanamiClient({
      endpoint: `http://127.0.0.1:${address.port}`,
      token: "projection-client-token",
    });
    await client.projects.create({
      name: "Projection client",
      sourcePath: null,
      code: "PCLI",
    });

    const projectReceipt: ProjectionReconcileReceipt =
      await client.projects.reconcileProjection("PCLI");
    expect(projectReceipt).toMatchObject({
      ok: true,
      project: { code: "PCLI" },
      attemptedAt: expect.any(String),
      projection: { status: "APPLIED", lag: 0 },
    });

    const batchReceipt: ProjectionBatchReceipt = await client.projections.reconcileAll();
    expect(batchReceipt).toMatchObject({
      ok: true,
      attempted: 1,
      applied: 1,
      deferred: 0,
      failed: 0,
      attemptedAt: expect.any(String),
      finishedAt: expect.any(String),
    });

    const status: SystemStatus = await client.status();
    expect(status).toMatchObject({
      ok: true,
      projectionSummary: {
        status: "APPLIED",
        appliedCount: 1,
        deferredCount: 0,
        missingCount: 0,
      },
      projectionFailures: [],
    });

    await expect(
      client.projects.reconcileProjection("NOTHERE"),
    ).rejects.toMatchObject<AyanamiClientError>({ code: "PROJECT_NOT_FOUND", status: 404 });
  });
});

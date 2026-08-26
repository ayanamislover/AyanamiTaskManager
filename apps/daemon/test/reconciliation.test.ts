import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "@ayanami-task/application";
import { buildAyanamiServer } from "../src/index.js";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("只读项目对账 REST", () => {
  it("默认仅返回需对账项，include_active 才附带正常项", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-reconcile-api-"));
    temporary.push(root);
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "ready.json"), "{}", "utf8");
    const service = await AyanamiTaskService.open({
      dataDir: join(root, "data"),
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    await service.createProject({ name: "REST 对账", sourcePath: root, code: "RAPI" });
    const objective = await service.createObjectiveAsUser("RAPI", "rest-reconcile-objective", {
      title: "REST 对账",
      description: "",
      definitionOfDone: [],
    });
    await service.createWorkItemsAsUser("RAPI", "rest-reconcile-tasks", [
      {
        clientRef: "possible",
        objectiveId: objective.id,
        title: "已有产物",
        type: "TASK",
        priority: "NORMAL",
        status: "READY",
        acceptance: ["存在 `dist/ready.json`"],
        checklist: [],
        verificationRequired: false,
      },
      {
        clientRef: "active",
        objectiveId: objective.id,
        title: "正常待办",
        type: "TASK",
        priority: "NORMAL",
        status: "READY",
        acceptance: ["通过行为验收"],
        checklist: [],
        verificationRequired: false,
      },
    ]);
    const app = await buildAyanamiServer({ service, token: "reconcile-secret" });
    const headers = { authorization: "Bearer reconcile-secret" };
    try {
      const attention = await app.inject({
        method: "GET",
        url: "/api/v1/projects/RAPI/reconciliation",
        headers,
      });
      expect(attention.statusCode).toBe(200);
      expect(attention.json()).toMatchObject({
        project: { code: "RAPI", sourceRoot: root },
        attentionCount: 1,
        counts: { ACTIVE: 1, POSSIBLY_COMPLETE: 1 },
      });
      expect(attention.json().items).toHaveLength(1);
      expect(attention.json().items[0]).toMatchObject({ classification: "POSSIBLY_COMPLETE" });

      const withActive = await app.inject({
        method: "GET",
        url: "/api/v1/projects/RAPI/reconciliation?include_active=1",
        headers,
      });
      expect(withActive.statusCode).toBe(200);
      expect(withActive.json().items).toHaveLength(2);
      expect(withActive.json().items.map((item: any) => item.classification)).toContain("ACTIVE");
    } finally {
      await app.close();
      service.close();
    }
  });
});

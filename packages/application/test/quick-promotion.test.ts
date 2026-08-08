import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Quick Task", () => {
  it("简单任务不创建项目库，晋升后只生成一个正式工作项", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-quick-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      const begun = await service.begin({
        agentId: "codex",
        title: "修正文案",
        mode: "auto",
        signals: { expectedMinutes: 10 },
      });
      expect(begun.scope).toBe("quick");
      expect(service.listProjects()).toHaveLength(0);
      const promoted = await service.promoteQuickTask({
        quickTask: begun.quick.key,
        expectedVersion: begun.quick.version,
        actor: "codex",
      });
      expect(promoted.status).toBe("PROMOTED");
      expect(service.listProjects()).toHaveLength(1);
      const project = service.listProjects()[0]!;
      expect(await service.listWorkItems(project.code)).toHaveLength(1);
      const replay = await service.promoteQuickTask({
        quickTask: begun.quick.key,
        expectedVersion: begun.quick.version,
        actor: "codex",
      });
      expect(replay.promotedWorkItemKey).toBe(promoted.promotedWorkItemKey);
      expect(await service.listWorkItems(project.code)).toHaveLength(1);
    } finally {
      service.close();
    }
  });
});

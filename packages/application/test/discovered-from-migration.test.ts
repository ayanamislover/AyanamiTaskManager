import { copyFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("DISCOVERED_FROM schema migration", () => {
  it("从 v3 升级时保留 BLOCKS，新增来源关系并按外键级联删除", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-discovered-migration-"));
    temporary.push(root);
    const dataDir = join(root, "data");
    const migrationsRoot = join(root, "migrations");
    cpSync(resolve(process.cwd(), "migrations"), migrationsRoot, { recursive: true });
    rmSync(join(migrationsRoot, "project", "0004_discovered_from.sql"));
    rmSync(join(migrationsRoot, "project", "0005_session_git_context.sql"));

    let service = await AyanamiTaskService.open({ dataDir, migrationsRoot });
    const project = await service.createProject({
      name: "关系升级",
      sourcePath: null,
      code: "UPREL",
    });
    const objective = await service.createObjectiveAsUser(project.code, "v3-objective", {
      title: "升级关系模型",
      description: "",
      definitionOfDone: [],
    });
    const v3Tasks = await service.createWorkItemsAsUser(project.code, "v3-plan", [
      {
        clientRef: "origin",
        objectiveId: objective.id,
        title: "原任务",
        type: "TASK",
        priority: "NORMAL",
        status: "READY",
      },
      {
        clientRef: "blocked",
        objectiveId: objective.id,
        dependsOnRefs: ["origin"],
        title: "依赖任务",
        type: "TASK",
        priority: "NORMAL",
        status: "READY",
      },
    ]);
    service.close();

    copyFileSync(
      resolve(process.cwd(), "migrations", "project", "0004_discovered_from.sql"),
      join(migrationsRoot, "project", "0004_discovered_from.sql"),
    );
    copyFileSync(
      resolve(process.cwd(), "migrations", "project", "0005_session_git_context.sql"),
      join(migrationsRoot, "project", "0005_session_git_context.sql"),
    );
    service = await AyanamiTaskService.open({ dataDir, migrationsRoot });
    try {
      const begun = await service.begin({ projectCode: project.code, agentId: "codex-v4" });
      expect(
        (await service.getWorkItem(project.code, v3Tasks.items[1]!.key, "context")).dependencies,
      ).toEqual([v3Tasks.items[0]!.key]);

      const followUp = await service.createWorkItems(project.code, begun.session, "v4-discover", [
        {
          clientRef: "follow-up",
          objectiveId: objective.id,
          discoveredFrom: v3Tasks.items[0]!.key,
          title: "升级后发现",
          type: "TASK",
          priority: "HIGH",
          status: "READY",
        },
      ]);
      expect(
        (await service.getWorkItem(project.code, followUp.items[0]!.key, "context")).discoveredFrom,
      ).toBe(v3Tasks.items[0]!.key);

      const database = await service.databases.openProject(project.code);
      database.sqlite.prepare("DELETE FROM work_items WHERE id = ?").run(v3Tasks.items[0]!.id);
      expect(
        database.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM work_item_relations WHERE relation_type = 'DISCOVERED_FROM'",
          )
          .get(),
      ).toMatchObject({ count: 0 });
      expect(
        await service.getWorkItem(project.code, followUp.items[0]!.key, "context"),
      ).toMatchObject({
        discoveredFrom: null,
      });
    } finally {
      service.close();
    }
  });
});

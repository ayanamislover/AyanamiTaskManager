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
    const pendingMigrations = [
      "0004_discovered_from.sql",
      "0005_session_git_context.sql",
      "0006_record_topics.sql",
      "0007_operation_trace.sql",
      "0008_work_item_phase_waiting.sql",
      "0009_structured_cancel.sql",
      "0010_review_workflow.sql",
      "0011_session_close_reason.sql",
      "0012_project_update_evidence.sql",
      "0013_project_update_session.sql",
    ];
    for (const name of pendingMigrations) rmSync(join(migrationsRoot, "project", name));

    let service = await AyanamiTaskService.open({ dataDir, migrationsRoot });
    const project = await service.createProject({
      name: "关系升级",
      sourcePath: null,
      code: "UPREL",
    });
    const v3Database = await service.databases.openProject(project.code);
    const now = "2026-08-26T00:00:00.000Z";
    v3Database.sqlite
      .prepare(
        `INSERT INTO objectives(
           id, local_no, title, description, definition_of_done_json, status,
           weight, version, created_at, updated_at
         ) VALUES ('v3-objective', 1, '升级关系模型', '', '[]', 'ACTIVE', 1, 0, ?, ?)`,
      )
      .run(now, now);
    const v3Tasks = {
      items: [
        { id: "v3-origin", key: "UPREL-T-0001" },
        { id: "v3-blocked", key: "UPREL-T-0002" },
      ],
    };
    for (const [index, task] of v3Tasks.items.entries()) {
      v3Database.sqlite
        .prepare(
          `INSERT INTO work_items(
             id, local_no, objective_id, type, title, status, priority, sort_key,
             version, created_at, updated_at
           ) VALUES (?, ?, 'v3-objective', 'TASK', ?, 'READY', 'NORMAL', ?, 0, ?, ?)`,
        )
        .run(task.id, index + 1, index === 0 ? "原任务" : "依赖任务", (index + 1) * 1000, now, now);
    }
    v3Database.sqlite
      .prepare(
        `INSERT INTO work_item_relations(source_id, target_id, relation_type, created_at)
         VALUES ('v3-origin', 'v3-blocked', 'BLOCKS', ?)`,
      )
      .run(now);
    v3Database.sqlite.prepare("UPDATE counters SET next_value = 3 WHERE name = 'work_item'").run();
    service.close();

    for (const name of pendingMigrations) {
      copyFileSync(
        resolve(process.cwd(), "migrations", "project", name),
        join(migrationsRoot, "project", name),
      );
    }
    service = await AyanamiTaskService.open({ dataDir, migrationsRoot });
    try {
      const begun = await service.begin({ projectCode: project.code, agentId: "codex-v4" });
      expect(
        (await service.getWorkItem(project.code, v3Tasks.items[1]!.key, "context")).dependencies,
      ).toEqual([v3Tasks.items[0]!.key]);

      const followUp = await service.createWorkItems(project.code, begun.session, "v4-discover", [
        {
          clientRef: "follow-up",
          objectiveId: "v3-objective",
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

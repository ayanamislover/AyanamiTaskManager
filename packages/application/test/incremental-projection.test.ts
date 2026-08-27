import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("Registry 增量搜索投影", () => {
  it("任务编辑和多次进度只更新相关文档，不因重复任务键丢失摘要", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "atm-incremental-projection-"));
    roots.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: join(process.cwd(), "migrations"),
    });
    const project = await service.createProject({
      name: "增量投影",
      sourcePath: null,
      code: "IPR",
    });
    const objective = await service.createObjectiveAsUser(project.code, "objective", {
      title: "验证投影",
      description: "",
      definitionOfDone: [],
    });
    const created = await service.createWorkItemsAsUser(project.code, "task", [
      {
        clientRef: "task",
        objectiveId: objective.id,
        title: "旧搜索标题",
        description: "",
        type: "TASK",
        priority: "NORMAL",
        status: "READY",
        acceptance: [],
        checklist: [],
        verificationRequired: false,
      },
    ]);
    const task = created.items[0]!;
    const begun = await service.begin({
      projectCode: project.code,
      mode: "project",
      agentId: "projection-agent",
      clientKind: "test",
    });
    await service.patchWorkItemsAsUser(project.code, "edit", [
      {
        taskKey: task.key,
        expectedVersion: task.version,
        operation: "edit",
        title: "新的中文搜索标题",
      },
    ]);
    await service.addProgress(project.code, String(begun.session), "progress-1", {
      taskKey: task.key,
      summary: "第一次进度摘要",
      completed: [],
      next: [],
      evidence: [],
      percent: 10,
    });
    await service.addProgress(project.code, String(begun.session), "progress-2", {
      taskKey: task.key,
      summary: "第二次进度摘要",
      completed: [],
      next: [],
      evidence: [],
      percent: 20,
    });

    // 同一毫秒内生成的 ULID 含随机熵，不能把字典序当作提交顺序。
    // 强制制造“旧记录 ID 更大”的并列时间戳，并重放最新 outbox；旧实现会
    // 错把第一次进度投影回 Registry，使下面的第二次摘要搜索失败。
    const projectDatabase = await service.databases.openProject(project.id);
    const progressDocuments = projectDatabase.sqlite
      .prepare(
        `SELECT entity_id, title FROM search_documents
         WHERE entity_type = 'PROGRESS' ORDER BY rowid`,
      )
      .all() as Array<{ entity_id: string; title: string }>;
    expect(progressDocuments.map((document) => document.title)).toEqual([
      "第一次进度摘要",
      "第二次进度摘要",
    ]);
    projectDatabase.sqlite.transaction(() => {
      projectDatabase.sqlite
        .prepare(
          `UPDATE search_documents
           SET entity_id = CASE title
             WHEN '第一次进度摘要' THEN 'ZZ-FIRST'
             WHEN '第二次进度摘要' THEN 'AA-SECOND'
           END,
           updated_at = '2026-08-27T12:00:00.000Z'
           WHERE entity_type = 'PROGRESS'`,
        )
        .run();
      projectDatabase.sqlite
        .prepare(
          `UPDATE outbox SET delivered_at = NULL
           WHERE project_sequence = (SELECT MAX(project_sequence) FROM outbox)`,
        )
        .run();
    })();
    await service.databases.dispatchProject(project.id);

    expect(service.globalSearch("第二次进度摘要").hits).toHaveLength(1);
    service.databases.registry.sqlite
      .prepare(
        `UPDATE project_summary_cache SET project_sequence = project_sequence - 1
         WHERE project_id = ?`,
      )
      .run(project.id);
    await service.databases.dispatchProject(project.id);

    expect(service.globalSearch("新的中文搜索标题").hits).toHaveLength(1);
    expect(service.globalSearch("第二次进度摘要").hits).toHaveLength(1);
    expect(
      service.overview().projects.find((entry: any) => entry.code === project.code)
        ?.project_sequence,
    ).toBeGreaterThanOrEqual(5);
    service.close();
  });
});

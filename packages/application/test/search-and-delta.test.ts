import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("中文搜索与增量事件", () => {
  it("trigram 与短词回退都能命中，delta 序列无重复和跳号", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-search-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      const project = await service.createProject({ name: "搜索测试", sourcePath: null });
      const begun = await service.begin({ projectCode: project.code, agentId: "codex" });
      const objective = await service.createObjective(project.code, begun.session, {
        title: "可靠性",
        description: "",
        definitionOfDone: [],
      });
      const milestone = await service.createMilestone(project.code, begun.session, {
        objectiveId: objective.id,
        title: "数据库",
      });
      await service.createWorkItems(project.code, begun.session, "plan", [
        {
          clientRef: "migration",
          objectiveId: objective.id,
          milestoneId: milestone.id,
          title: "数据库迁移与恢复",
          description: "验证中文子串查询",
          type: "TASK",
          priority: "HIGH",
          status: "READY",
        },
      ]);
      expect((await service.search(project.code, "数据库"))[0]?.title).toContain("数据库");
      expect((await service.search(project.code, "迁移"))[0]?.title).toContain("迁移");
      const record = await service.createRecord(project.code, begun.session, "record-exact", {
        kind: "FACT",
        title: "精确记录读取",
        summary: "公开 key 必须可以直接读取",
        detail: "完整 detail 不经过全文检索",
      });
      expect(await service.getRecord(project.code, record.key)).toMatchObject({
        key: record.key,
        detail: "完整 detail 不经过全文检索",
      });
      const delta = await service.delta(project.code, 0, 100);
      expect(delta.events.length).toBeGreaterThan(0);
      expect(delta.events.map((event) => event.seq)).toEqual(
        Array.from({ length: delta.events.length }, (_, index) => index + 1),
      );
    } finally {
      service.close();
    }
  });
});

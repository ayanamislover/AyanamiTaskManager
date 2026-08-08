import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("agenttask.md 一次性导入", () => {
  it("先预览、保留无法归类文本，并以文件哈希幂等应用", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-agenttask-import-"));
    temporary.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      await service.createProject({ name: "导入目标", sourcePath: null, code: "IMP" });
      const content = [
        "# 桌面交付",
        "这一段是目标背景，不能丢失。",
        "## 可靠性",
        "- [x] 完成迁移校验",
        "- [ ] 完成在线备份",
        "1. 保留原始发布决定",
        "普通补充文本。",
      ].join("\n");

      const preview = service.previewAgentTaskImport("IMP", content, "agenttask.md");
      expect(preview).toMatchObject({
        alreadyImported: false,
        taskCount: 2,
        objectiveCount: 1,
        milestoneCount: 1,
      });
      expect(await service.listWorkItems("IMP")).toHaveLength(0);

      const applied = await service.applyAgentTaskImport(
        "IMP",
        content,
        "agenttask.md",
        preview.sha256,
      );
      expect(applied).toMatchObject({ alreadyImported: false, importedTasks: 2 });
      expect(await service.listWorkItems("IMP", { limit: 20 })).toHaveLength(2);
      const records = await service.listRecords("IMP");
      expect(records.map((record) => `${record.summary}\n${record.detail}`).join("\n")).toContain(
        "目标背景",
      );
      expect(records.map((record) => `${record.summary}\n${record.detail}`).join("\n")).toContain(
        "原始发布决定",
      );
      expect(records.map((record) => `${record.summary}\n${record.detail}`).join("\n")).toContain(
        "普通补充文本",
      );

      const retried = await service.applyAgentTaskImport(
        "IMP",
        content,
        "agenttask.md",
        preview.sha256,
      );
      expect(retried.alreadyImported).toBe(true);
      expect(await service.listWorkItems("IMP", { limit: 20 })).toHaveLength(2);
    } finally {
      service.close();
    }
  });
});

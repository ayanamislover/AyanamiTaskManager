import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { AyanamiTaskService } from "../src/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Knowledge application boundary", () => {
  it("Agent目录摘要不会吞掉整页预算，可直接按唯一标题读取未列出的章节", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-knowledge-toc-"));
    roots.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve("migrations"),
    });
    try {
      const entry = await service.knowledge.save({
        opId: "create",
        expectedVersion: 0,
        slug: "many-sections",
        title: "多章节",
        summary: "目录也需有界",
        bodyMarkdown: Array.from(
          { length: 100 },
          (_, index) => `# 章节${index}\n内容${index}\n`,
        ).join(""),
      });
      const first = await service.knowledge.getForAgent({ id: entry.id, maxChars: 1800 });
      expect(first).toMatchObject({ tocTotal: 100, tocTruncated: true });
      expect(first.bodyMarkdown.length).toBeGreaterThan(0);
      expect(JSON.stringify(first).length).toBeLessThanOrEqual(1800);
      const selected = await service.knowledge.getForAgent({
        id: entry.id,
        revisionId: entry.revisionId,
        section: "章节99",
        maxChars: 1800,
      });
      expect(selected.bodyMarkdown).toBe("# 章节99\n内容99\n");
      const longTitle = await service.knowledge.save({
        opId: "long-heading",
        expectedVersion: 0,
        slug: "long-heading",
        title: "长标题",
        summary: "标题不能导致正文无法读取",
        bodyMarkdown: `# ${"标题".repeat(10_000)}\n正文`,
      });
      await expect(
        service.knowledge.getForAgent({ id: longTitle.id, maxChars: 1800 }),
      ).resolves.toHaveProperty("nextCursor");
      const languages = await service.knowledge.save({
        opId: "languages",
        expectedVersion: 0,
        slug: "languages",
        title: "语言",
        summary: "章节匹配",
        bodyMarkdown: "# C#\nCSharp\n# 验证 ###\n验证步骤\n# 重复\n一\n# 重复\n二",
      });
      expect(
        (await service.knowledge.getForAgent({ id: languages.id, section: "C#" })).bodyMarkdown,
      ).toBe("# C#\nCSharp\n");
      await expect(
        service.knowledge.getForAgent({ id: languages.id, section: "重复" }),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
        details: { candidateIds: ["h-3", "h-4"] },
      });
    } finally {
      service.close();
    }
  });
  it("Agent实际紧凑形状参与预算：搜索更短，续页小预算不重复已读元数据", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-knowledge-budget-"));
    roots.push(dataDir);
    const service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: resolve("migrations"),
    });
    try {
      const entry = await service.knowledge.save({
        opId: "create",
        expectedVersion: 0,
        slug: "efficient",
        title: "约定",
        summary: "用于判断是否适用。".repeat(60),
        aliases: ["供界面检索的别名".repeat(15)],
        bodyMarkdown: "操作和验证步骤。".repeat(2000),
      });
      const uiSearch = await service.knowledge.search({ query: "约定", maxChars: 3000 });
      const agentSearch = await service.knowledge.searchForAgent({ query: "约定", maxChars: 3000 });
      expect(JSON.stringify(agentSearch).length).toBeLessThan(JSON.stringify(uiSearch).length);
      const uiFirst = await service.knowledge.get({ id: entry.id, maxChars: 2000 });
      const agentFirst = await service.knowledge.getForAgent({ id: entry.id, maxChars: 2000 });
      expect(agentFirst.bodyMarkdown.length).toBeGreaterThan(uiFirst.bodyMarkdown.length);
      expect(JSON.stringify(agentFirst).length).toBeLessThanOrEqual(2000);
      const next = await service.knowledge.getForAgent({
        id: entry.id,
        cursor: agentFirst.nextCursor!,
        maxChars: 800,
      });
      expect(next.bodyMarkdown.length).toBeGreaterThan(0);
      expect(JSON.stringify(next).length).toBeLessThanOrEqual(800);
      expect(next).not.toHaveProperty("toc");
      expect(next).not.toHaveProperty("title");
      await expect(
        service.knowledge.get({ id: entry.id, cursor: uiFirst.nextCursor!, maxChars: 800 }),
      ).rejects.toMatchObject({ code: "RESULT_TOO_LARGE" });
    } finally {
      service.close();
    }
  });
  it("提炼预览不发布、版本固定；来源失效后知识仍可跨项目独立读取且不随项目导出", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-knowledge-source-"));
    roots.push(dataDir);
    let service = await AyanamiTaskService.open({ dataDir, migrationsRoot: resolve("migrations") });
    try {
      const project = await service.createProject({
        name: "知识来源",
        code: "SRC",
        sourcePath: null,
      });
      const session = await service.begin({
        projectCode: "SRC",
        mode: "project",
        agentId: "knowledge-author",
        clientKind: "test",
        role: "SUBAGENT",
      });
      const record = await service.createRecord("SRC", String(session.session), "record", {
        kind: "LESSON",
        title: "通用经验",
        summary: "供参考",
        detail: "共享知识正文不应随项目泄露",
        scope: "GLOBAL",
      });
      expect((await service.knowledge.search({})).hits).toHaveLength(0);
      const preview = await service.knowledge.previewRecord("SRC", record.key);
      expect(preview.sourceRef).toMatchObject({
        type: "project_record",
        reference: record.key,
        projectId: project.id,
        sourceVersion: 0,
      });
      expect((await service.knowledge.search({})).hits).toHaveLength(0);
      const knowledge = await service.knowledge.save({
        ...preview,
        slug: "common",
        opId: "publish",
        expectedVersion: 0,
        bodyMarkdown: "只在知识库存储的私有哨兵XYZ",
        sourceRefs: [preview.sourceRef],
      });
      await service.createRecord("SRC", String(session.session), "supersede", {
        kind: "LESSON",
        title: "后续经验",
        summary: "替代",
        supersedes: record.key,
      });
      expect(
        (await service.knowledge.previewRecord("SRC", record.key)).sourceRef.sourceVersion,
      ).toBe(1);
      expect(
        (await service.knowledge.get({ id: knowledge.id, revisionId: knowledge.revisionId }))
          .sourceRefs[0]?.sourceVersion,
      ).toBe(0);
      const exported = await service.exportProject("SRC", "aytproj");
      const archive = unzipSync(new Uint8Array(readFileSync(exported.path)));
      expect(Object.keys(archive).some((path) => path.includes("knowledge"))).toBe(false);
      for (const bytes of Object.values(archive))
        expect(Buffer.from(bytes).includes(Buffer.from("只在知识库存储的私有哨兵XYZ"))).toBe(false);
      await service.trashProject("SRC");
      service.close();
      // Fixture removes only its own source DB: the published snapshot has no foreign key to it.
      rmSync(project.databasePath, { force: true });
      service = await AyanamiTaskService.open({ dataDir, migrationsRoot: resolve("migrations") });
      expect(
        await service.knowledge.get({ id: knowledge.id, revisionId: knowledge.revisionId }),
      ).toMatchObject({
        title: preview.title,
        bodyMarkdown: "只在知识库存储的私有哨兵XYZ",
      });
      await expect(service.knowledge.previewRecord("SRC", record.key)).rejects.toThrow();
    } finally {
      service.close();
    }
  });
});

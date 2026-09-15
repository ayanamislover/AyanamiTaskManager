import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  renameSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AyanamiDatabaseManager, searchKnowledge, getKnowledge } from "../src/index.js";
import { prepareKnowledgeRestore } from "../src/knowledge-restore.js";

const directories: string[] = [];
const managers: AyanamiDatabaseManager[] = [];
const migrationsRoot = resolve("migrations");
function directory() {
  const path = mkdtempSync(join(tmpdir(), "atm-knowledge-"));
  directories.push(path);
  return path;
}
async function open(dataDir = directory()) {
  const manager = await AyanamiDatabaseManager.open({ dataDir, migrationsRoot });
  managers.push(manager);
  return manager;
}
const content = {
  opId: "create",
  expectedVersion: 0,
  slug: "windows",
  title: "Windows 安全",
  summary: "安全管道",
  bodyMarkdown: "# 原始内容\n保持安全。",
};
afterEach(() => {
  for (const manager of managers.splice(0)) manager.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("独立知识库存储", () => {
  it("不把外键损坏、无法恢复的知识快照登记为成功备份", async () => {
    const manager = await open();
    const repository = await manager.knowledge.open();
    repository.save(content);
    repository.database.sqlite.pragma("foreign_keys=OFF");
    repository.database.sqlite
      .prepare(
        "INSERT INTO knowledge_revisions(entry_id,revision,revision_id,snapshot) VALUES('missing',1,'01M2FQ84H01NRV2KEXYT6NK2J7','{}')",
      )
      .run();
    repository.database.sqlite.pragma("foreign_keys=ON");
    await expect(
      manager.createBackup({ scope: "KNOWLEDGE", reason: "MANUAL" }),
    ).rejects.toMatchObject({ code: "BACKUP_INTEGRITY_FAILED" });
    expect(manager.listBackups()).toEqual([]);
  });
  it("prepare后、journal前中断的恢复候选在下一次打开时保留隔离，不积在活动目录", async () => {
    const manager = await open();
    const entry = (await manager.knowledge.open()).save(content);
    const backup = await manager.createBackup({ scope: "KNOWLEDGE", reason: "MANUAL" });
    await prepareKnowledgeRestore(manager.dataDir, migrationsRoot, backup.path);
    manager.close();
    expect(
      readdirSync(join(manager.dataDir, "knowledge")).some((name) =>
        /^restore-.*\.sqlite$/u.test(name),
      ),
    ).toBe(true);
    const reopened = await (await open(manager.dataDir)).knowledge.open();
    expect(reopened.get(entry.id).bodyMarkdown).toBe(content.bodyMarkdown);
    expect(
      readdirSync(join(manager.dataDir, "knowledge")).some((name) =>
        /^restore-.*\.sqlite$/u.test(name),
      ),
    ).toBe(false);
    expect(
      readdirSync(join(manager.dataDir, "backups", "knowledge")).some((name) =>
        /^orphan-.*\.sqlite$/u.test(name),
      ),
    ).toBe(true);
  });
  it("同一daemon维护触发重叠时复用在途批次，不重复创建知识与Registry快照", async () => {
    const manager = await open();
    (await manager.knowledge.open()).save(content);
    const at = new Date("2026-09-14T12:00:00Z");
    const [first, second] = await Promise.all([
      manager.runMaintenance(at),
      manager.runMaintenance(at),
    ]);
    expect(first).toEqual(second);
    expect(manager.listBackups().filter((backup) => backup.reason === "DAILY")).toHaveLength(2);
    expect(manager.listBackups().filter((backup) => backup.reason === "WEEKLY")).toHaveLength(2);
  });
  it("恢复旧备份后数字序号即使重用，旧永久修订引用也绝不指向新正文", async () => {
    const manager = await open();
    const repository = await manager.knowledge.open();
    const initial = repository.save(content);
    const backup = await manager.createBackup({ scope: "KNOWLEDGE", reason: "MANUAL" });
    const oldSecond = repository.save({
      ...content,
      id: initial.id,
      expectedVersion: 1,
      expectedRevisionId: initial.revisionId,
      opId: "old-second",
      bodyMarkdown: "旧的第二版",
    });
    await manager.restoreBackup(backup.id);
    const restored = await manager.knowledge.open();
    const newSecond = restored.save({
      ...content,
      id: initial.id,
      expectedVersion: 1,
      expectedRevisionId: initial.revisionId,
      opId: "new-second",
      bodyMarkdown: "新的第二版",
    });
    expect(oldSecond.revision).toBe(newSecond.revision);
    expect(oldSecond.revisionId).not.toBe(newSecond.revisionId);
    expect(() =>
      getKnowledge(restored, { id: initial.id, revisionId: oldSecond.revisionId }),
    ).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
    expect(
      getKnowledge(restored, { id: initial.id, revisionId: initial.revisionId }).bodyMarkdown,
    ).toBe(content.bodyMarkdown);
    expect(
      getKnowledge(restored, { id: initial.id, revisionId: newSecond.revisionId }).bodyMarkdown,
    ).toBe("新的第二版");
    expect(() =>
      restored.save({
        ...content,
        id: initial.id,
        expectedVersion: 2,
        expectedRevisionId: oldSecond.revisionId,
        opId: "stale-aba",
      }),
    ).toThrowError(expect.objectContaining({ code: "VERSION_CONFLICT" }));
    expect(() =>
      restored.archive({
        id: initial.id,
        expectedVersion: 2,
        expectedRevisionId: oldSecond.revisionId,
        opId: "stale-archive-aba",
        archived: true,
      }),
    ).toThrowError(expect.objectContaining({ code: "VERSION_CONFLICT" }));
  });
  it("元数据检索不经完整正文读取路径", async () => {
    const repository = await (await open()).knowledge.open();
    const entry = repository.save({ ...content, bodyMarkdown: "长正文".repeat(50_000) });
    const read = vi.spyOn(repository, "get").mockImplementation(() => {
      throw new Error("search loaded full body");
    });
    try {
      expect(searchKnowledge(repository, { query: "Windows" }).hits[0]?.id).toBe(entry.id);
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });
  it("备份恢复保留 revision/引用并刷新游标 generation，恢复前数据保留", async () => {
    const manager = await open();
    const repository = await manager.knowledge.open();
    const entry = repository.save({ ...content, bodyMarkdown: "旧内容".repeat(2000) });
    const cursor = getKnowledge(repository, { id: entry.id, maxChars: 1600 }).nextCursor!;
    const backup = await manager.createBackup({ scope: "KNOWLEDGE", reason: "MANUAL" });
    repository.save({
      ...content,
      id: entry.id,
      expectedVersion: 1,
      expectedRevisionId: entry.revisionId,
      opId: "new",
      title: "新内容",
    });
    const result = await manager.restoreBackup(backup.id);
    expect(result.project).toBeNull();
    const restored = await manager.knowledge.open();
    expect(restored.get(entry.id).title).toBe(content.title);
    expect(restored.get(entry.id).revision).toBe(1);
    expect(() => getKnowledge(restored, { id: entry.id, cursor })).toThrowError(
      expect.objectContaining({ code: "INVALID_CURSOR" }),
    );
    expect(manager.listBackups()).toContainEqual(
      expect.objectContaining({ scope: "KNOWLEDGE", reason: "PRE_RESTORE" }),
    );
    expect(
      readdirSync(join(manager.dataDir, "backups", "knowledge")).some((name) =>
        name.startsWith("before-restore-"),
      ),
    ).toBe(true);
  });

  it("损坏的当前知识库可从有效快照恢复并保留原始坏文件", async () => {
    const manager = await open();
    const entry = (await manager.knowledge.open()).save(content);
    const backup = await manager.createBackup({ scope: "KNOWLEDGE", reason: "MANUAL" });
    const dataDir = manager.dataDir;
    manager.close();
    writeFileSync(join(dataDir, "knowledge", "knowledge.sqlite"), "corrupt original");
    const reopened = await open(dataDir);
    await expect(reopened.knowledge.open()).rejects.toMatchObject({
      code: "KNOWLEDGE_UNAVAILABLE",
    });
    await reopened.restoreBackup(backup.id);
    expect((await reopened.knowledge.open()).get(entry.id).title).toBe(content.title);
    const preserved = readdirSync(join(dataDir, "backups", "knowledge")).find((name) =>
      name.startsWith("before-restore-"),
    )!;
    expect(readFileSync(join(dataDir, "backups", "knowledge", preserved), "utf8")).toBe(
      "corrupt original",
    );
  });

  it("恢复换文件期间中断会回滚；已提交则保留恢复版和旧文件", async () => {
    for (const committed of [false, true]) {
      const manager = await open();
      const repository = await manager.knowledge.open();
      const entry = repository.save(content);
      const backup = await manager.createBackup({ scope: "KNOWLEDGE", reason: "MANUAL" });
      repository.save({
        ...content,
        id: entry.id,
        expectedVersion: 1,
        expectedRevisionId: entry.revisionId,
        opId: "new",
        title: "最新",
      });
      const dataDir = manager.dataDir;
      manager.close();
      const id = "01M2FQ84H01NRV2KEXYT6NK2J7";
      renameSync(
        join(dataDir, "knowledge", "knowledge.sqlite"),
        join(dataDir, "backups", "knowledge", `before-restore-${id}.sqlite`),
      );
      copyFileSync(backup.path, join(dataDir, "knowledge", "knowledge.sqlite"));
      writeFileSync(join(dataDir, "knowledge", "restore.json"), JSON.stringify({ id, committed }));
      const reopened = await (await open(dataDir)).knowledge.open();
      expect(reopened.get(entry.id).title).toBe(committed ? content.title : "最新");
    }
  });

  it("知识库备份与注册表备份独立保留，自动维护包括知识库", async () => {
    const manager = await open();
    (await manager.knowledge.open()).save(content);
    manager.setSetting("backup.policy", { enabled: true, dailyKeep: 1, weeklyKeep: 1 });
    for (const day of [1, 2, 3]) {
      const result = await manager.runMaintenance(new Date(`2026-09-0${day}T10:00:00Z`));
      expect(result.errors).toEqual([]);
      expect(result.dailyCreated).toBe(2);
    }
    const daily = manager.listBackups().filter((item) => item.reason === "DAILY");
    expect(daily.map((item) => item.scope).sort()).toEqual(["KNOWLEDGE", "REGISTRY"]);
  });
  it("多页超过固定前缀、中文短词与 SQL/FTS 特殊字面字符召回", async () => {
    const repository = await (await open()).knowledge.open();
    for (let index = 0; index < 65; index++)
      repository.save({
        ...content,
        opId: `entry-${index}`,
        slug: `entry-${index}`,
        bodyMarkdown: `恢复 部署 中文搜索 \\ 100% _ ' """ ${index}`,
        tags: index % 2 ? ["奇数"] : [],
      });
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const result = searchKnowledge(repository, {
        query: "恢复",
        limit: 7,
        maxChars: 5000,
        cursor,
      });
      ids.push(...result.hits.map((hit) => hit.id));
      expect(result.hits.every((hit) => !("bodyMarkdown" in hit))).toBe(true);
      cursor = result.nextCursor ?? undefined;
    } while (cursor);
    expect(new Set(ids).size).toBe(65);
    for (const query of ["部署", "中文搜索", "100%", "_", "'", '"""', "\\"])
      expect(searchKnowledge(repository, { query, limit: 1 }).hits).toHaveLength(1);
    expect(searchKnowledge(repository, { query: "不存在" }).hits).toEqual([]);
    expect(
      searchKnowledge(repository, { query: "恢复", tag: "奇数", limit: 50, maxChars: 50_000 }).hits,
    ).toHaveLength(32);
  });

  it("目录变更使 search 游标显式失效，但读取固定修订跨更新、归档与重启连续", async () => {
    const manager = await open();
    let repository = await manager.knowledge.open();
    const bodyMarkdown = "# 开始\n" + '内容😀\\"'.repeat(2500) + "\n## 第二节\n最后。";
    const entry = repository.save({ ...content, bodyMarkdown });
    const other = repository.save({ ...content, opId: "other", slug: "other" });
    const search = searchKnowledge(repository, { limit: 1 });
    let page = getKnowledge(repository, { id: entry.id, maxChars: 1500 });
    let actual = page.bodyMarkdown;
    repository.save({
      ...content,
      id: entry.id,
      expectedVersion: 1,
      expectedRevisionId: entry.revisionId,
      opId: "update",
      bodyMarkdown: "THIS MUST NOT APPEAR",
    });
    repository.archive({
      id: other.id,
      expectedVersion: 1,
      expectedRevisionId: other.revisionId,
      opId: "archive-other",
      archived: true,
    });
    expect(() => searchKnowledge(repository, { cursor: search.nextCursor! })).toThrowError(
      expect.objectContaining({ code: "INVALID_CURSOR" }),
    );
    manager.close();
    repository = await (await open(manager.dataDir)).knowledge.open();
    let chunks = 0;
    while (page.nextCursor) {
      const prior = page.nextCursor;
      page = getKnowledge(repository, { id: entry.id, cursor: prior, maxChars: 1800 });
      expect(JSON.stringify(page).length).toBeLessThanOrEqual(1800);
      expect(page.revision).toBe(1);
      expect(page.version).toBe(1);
      expect(page.nextCursor).not.toBe(prior);
      actual += page.bodyMarkdown;
      if (++chunks > 100) throw new Error("non-progressing cursor");
    }
    expect(actual).toBe(bodyMarkdown);
    expect(getKnowledge(repository, { id: entry.id }).bodyMarkdown).toBe("THIS MUST NOT APPEAR");
    expect(getKnowledge(repository, { id: other.id }).archived).toBe(true);
    expect(searchKnowledge(repository, {}).hits.map((hit) => hit.id)).toEqual([entry.id]);
  });

  it("章节忽略代码围栏；小预算报错且恢复 generation 使旧游标失效", async () => {
    const repository = await (await open()).knowledge.open();
    const entry = repository.save({
      ...content,
      bodyMarkdown:
        "# One\n```md\n# Not a heading\n```\n## Child\nchild\n# Two\n" + "second".repeat(2000),
    });
    const page = getKnowledge(repository, { id: entry.id, maxChars: 1600 });
    expect(page.toc.map((item) => item.title)).toEqual(["One", "Child", "Two"]);
    expect(getKnowledge(repository, { id: entry.id, section: "h-2" }).bodyMarkdown).toBe(
      "## Child\nchild\n",
    );
    expect(() => getKnowledge(repository, { id: entry.id, maxChars: 1 })).toThrowError(
      expect.objectContaining({ code: "RESULT_TOO_LARGE" }),
    );
    expect(() => searchKnowledge(repository, { maxChars: 1 })).toThrowError(
      expect.objectContaining({ code: "RESULT_TOO_LARGE" }),
    );
    expect(() =>
      getKnowledge(repository, {
        id: entry.id,
        cursor: page.nextCursor!,
        revisionId: "01M2FQ84H01NRV2KEXYT6NK2J7",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_CURSOR" }));
    repository.resetGeneration();
    expect(() => getKnowledge(repository, { id: entry.id, cursor: page.nextCursor! })).toThrowError(
      expect.objectContaining({ code: "INVALID_CURSOR" }),
    );
  });
  it("零项目可用，完整快照不可变，重试优先于版本检查", async () => {
    const manager = await open();
    const repository = await manager.knowledge.open();
    const initial = repository.save(content);
    const next = repository.save({
      ...content,
      id: initial.id,
      opId: "edit",
      expectedVersion: 1,
      expectedRevisionId: initial.revisionId,
      title: "新标题",
      slug: "changed",
      bodyMarkdown: "新正文",
    });
    expect(next).toMatchObject({ id: initial.id, revision: 2, version: 2, title: "新标题" });
    expect(repository.get(initial.id, 1)).toMatchObject({
      revision: 1,
      title: content.title,
      slug: content.slug,
      bodyMarkdown: content.bodyMarkdown,
    });
    expect(repository.save(content)).toEqual(initial);
    expect(() => repository.save({ ...content, summary: "different" })).toThrowError(
      expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }),
    );
    expect(() =>
      repository.save({
        ...content,
        id: initial.id,
        opId: "stale",
        expectedVersion: 1,
        expectedRevisionId: initial.revisionId,
      }),
    ).toThrowError(expect.objectContaining({ code: "VERSION_CONFLICT" }));
    expect(repository.history(initial.id).revisions.map((item) => item.revision)).toEqual([2, 1]);
    expect(() =>
      repository.database.sqlite.prepare("UPDATE knowledge_revisions SET snapshot='{}'").run(),
    ).toThrow("immutable");
    expect(() =>
      repository.database.sqlite.prepare("DELETE FROM knowledge_revisions").run(),
    ).toThrow("immutable");
    const archived = repository.archive({
      id: initial.id,
      expectedVersion: 2,
      expectedRevisionId: next.revisionId,
      opId: "archive",
      archived: true,
    });
    expect(archived).toMatchObject({ archived: true, version: 3, revision: 2 });
    expect(repository.get(initial.id, 1).archived).toBe(true);
    expect(manager.listProjects()).toEqual([]);
  });

  it("索引写入失败时回滚修订、head、sequence 和回执", async () => {
    const repository = await (await open()).knowledge.open();
    const initial = repository.save(content);
    const identity = repository.identity();
    repository.database.sqlite.exec("DROP TABLE knowledge_fts");
    expect(() =>
      repository.save({
        ...content,
        id: initial.id,
        opId: "failed",
        expectedVersion: 1,
        expectedRevisionId: initial.revisionId,
      }),
    ).toThrow();
    expect(repository.get(initial.id)).toEqual(initial);
    expect(repository.history(initial.id).revisions).toHaveLength(1);
    expect(repository.identity()).toEqual(identity);
    expect(
      repository.database.sqlite
        .prepare("SELECT count(*) AS n FROM knowledge_operations WHERE op_id='failed'")
        .get(),
    ).toEqual({ n: 0 });
  });

  it("损坏知识库不阻止任务数据库启动和项目创建", async () => {
    const dataDir = directory();
    mkdirSync(join(dataDir, "knowledge"));
    writeFileSync(join(dataDir, "knowledge", "knowledge.sqlite"), "corrupt fixture");
    const manager = await open(dataDir);
    await expect(manager.knowledge.open()).rejects.toMatchObject({ code: "KNOWLEDGE_UNAVAILABLE" });
    await expect(
      manager.createProject({ name: "仍可工作", sourcePath: null }),
    ).resolves.toMatchObject({ lifecycle: "ACTIVE" });
  });

  it("相同 dataDir 重开保持 identity/修订；其他 dataDir 隔离", async () => {
    const manager = await open();
    const repository = await manager.knowledge.open();
    const entry = repository.save(content);
    const identity = repository.identity();
    manager.close();
    const reopened = await (await open(manager.dataDir)).knowledge.open();
    expect(reopened.identity()).toEqual(identity);
    expect(reopened.get(entry.id)).toEqual(entry);
    const other = await (await open()).knowledge.open();
    expect(other.identity().database_id).not.toBe(identity.database_id);
    expect(() => other.get(entry.id)).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
  });
});

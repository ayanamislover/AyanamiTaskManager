import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager, ProjectRepository } from "../src/index.js";

// 出自 ATM-T-0348 的独立复核探针，只保留经变异实测确认有守卫价值的两条。
//
//   1. restoreFrom(source) 是 manager.knowledge 上的公开方法，此前只被 restoreBackup
//      间接调用过。它和 restoreBackup 的区别是不查备份登记，任何一份完好的知识库文件
//      都能喂进来——这条用例钉的就是这个入口本身。恢复后的 ABA 语义由
//      knowledge.test.ts 从 restoreBackup 那侧压，这里不重复断言。
//   2. 恢复只能动 knowledge/ 与 backups/，registry 与项目库要逐字节不变。
//      改这条之前 test/ 下没有任何用例做过字节级比对；实测把一个无关文件写到 dataDir
//      根下时，整个 storage-sqlite 套件里只有这条会红。
//
// 有一条断言被有意删掉了：「冲突被拒之后正文不变」。把版本检查挪到写入之后再抛，
// 这条依然全绿——mutate 是 .immediate() 事务，抛出就回滚，正文本来就不可能变。
// 那是一条永远红不了的断言，留着只会假装有人在看。

const directories: string[] = [];
const managers: AyanamiDatabaseManager[] = [];
const migrationsRoot = resolve("migrations");

afterEach(() => {
  for (const manager of managers.splice(0)) manager.close();
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true, maxRetries: 8 });
});

async function open() {
  const dataDir = mkdtempSync(join(tmpdir(), "atm-knowledge-restore-"));
  directories.push(dataDir);
  const manager = await AyanamiDatabaseManager.open({ dataDir, migrationsRoot });
  managers.push(manager);
  return { manager, dataDir, repository: await manager.knowledge.open() };
}

const content = {
  slug: "restore",
  title: "恢复语义",
  summary: "恢复语义",
  bodyMarkdown: "初版正文",
};

/** 把当前知识库原样落成一个可直接喂给 restoreFrom 的文件。 */
function snapshot(
  repository: Awaited<ReturnType<typeof open>>["repository"],
  dataDir: string,
  name: string,
): string {
  const target = join(dataDir, name);
  repository.database.sqlite.pragma("wal_checkpoint(TRUNCATE)");
  copyFileSync(join(dataDir, "knowledge", "knowledge.sqlite"), target);
  return target;
}

describe("知识库恢复的对外边界", () => {
  it("restoreFrom 接受未登记为备份的任意知识库文件并真正换掉当前库", async () => {
    const { manager, dataDir, repository } = await open();
    const created = repository.save({ ...content, opId: "create", expectedVersion: 0 });
    const source = snapshot(repository, dataDir, "snapshot.sqlite");

    const second = repository.save({
      ...content,
      opId: "second",
      id: created.id,
      expectedVersion: created.version,
      expectedRevisionId: created.revisionId,
      bodyMarkdown: "恢复前的第二版",
    });
    expect(second.revision).toBe(2);
    const held = { id: second.id, version: second.version, revisionId: second.revisionId };

    await manager.knowledge.restoreFrom(source);
    const restored = await manager.knowledge.open();

    // 数字序号会被重新用掉，但 revisionId 必须换一个，否则旧句柄会认错正文。
    const reused = restored.save({
      ...content,
      opId: "reused",
      id: created.id,
      expectedVersion: 1,
      expectedRevisionId: created.revisionId,
      bodyMarkdown: "恢复后的第二版",
    });
    expect(reused.revision).toBe(second.revision);
    expect(reused.revisionId).not.toBe(held.revisionId);

    expect(() =>
      restored.save({
        ...content,
        opId: "stale",
        id: held.id,
        expectedVersion: held.version,
        expectedRevisionId: held.revisionId,
        bodyMarkdown: "不该落地",
      }),
    ).toThrowError(expect.objectContaining({ code: "VERSION_CONFLICT" }));
  });

  it("恢复知识库不触碰 registry 与项目数据库", async () => {
    const { manager, dataDir, repository } = await open();
    const project = await manager.createProject({
      name: "正式项目",
      sourcePath: null,
      code: "PRD",
    });
    new ProjectRepository(await manager.openProject(project.id)).createSession({
      agentId: "agent",
      displayName: "agent",
      clientKind: "test",
      role: "PRIMARY",
    });
    repository.save({ ...content, opId: "create", expectedVersion: 0 });

    const fingerprint = () => {
      const seen: Record<string, string> = {};
      const walk = (directory: string) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const full = join(directory, entry.name);
          if (entry.isDirectory()) {
            // knowledge/ 与 backups/ 正是恢复要动的地方，不纳入比对。
            if (entry.name === "knowledge" || entry.name === "backups") continue;
            walk(full);
          } else if (entry.isFile()) {
            seen[full.slice(dataDir.length)] = createHash("sha256")
              .update(readFileSync(full))
              .digest("hex");
          }
        }
      };
      walk(dataDir);
      return seen;
    };

    const source = snapshot(repository, dataDir, "snapshot.sqlite");
    manager.closeProject(project.id);

    const before = fingerprint();
    // 阳性对照：比对的是真有内容的一组文件，不是空对象恒等于空对象。
    expect(Object.keys(before).length).toBeGreaterThan(0);
    await manager.knowledge.restoreFrom(source);
    expect(fingerprint()).toEqual(before);
  });
});

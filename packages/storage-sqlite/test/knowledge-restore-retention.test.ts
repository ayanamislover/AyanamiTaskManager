import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager } from "../src/index.js";

const temporary: string[] = [];
const managers: AyanamiDatabaseManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.close();
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function openManager(prefix: string) {
  const dataDir = mkdtempSync(join(tmpdir(), `atm-knowledge-restore-${prefix}-`));
  temporary.push(dataDir);
  const manager = await AyanamiDatabaseManager.open({
    dataDir,
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  managers.push(manager);
  return { dataDir, manager };
}

const content = {
  opId: "create",
  expectedVersion: 0,
  slug: "retention",
  title: "第一版",
  summary: "保留策略与恢复",
  bodyMarkdown: "# 第一版",
};

describe("知识库恢复与备份保留", () => {
  /**
   * 恢复知识库时会先建一份 PRE_RESTORE。给 PRE_RESTORE 设了上限之后，这一份新建
   * 会触发同类修剪，把最旧的一份删掉——而最旧的那份正是用户选中要恢复的快照，
   * 于是 restoreFrom 以 ENOENT 失败，恢复点也没了。
   *
   * 两种参数都要覆盖：keep=2 时目标要排到第三份才被挤掉，keep=1 时只需目标自己一份。
   */
  it.each([
    [2, 1],
    [1, 0],
  ])("otherKeep=%i 时恢复不会删掉自己正在恢复的那一份", async (otherKeep, extra) => {
    const { manager } = await openManager(`keep-${otherKeep}`);
    manager.setSetting("backup.policy", { enabled: true, dailyKeep: 2, weeklyKeep: 2, otherKeep });
    const repository = await manager.knowledge.open();
    const first = repository.save(content);
    const target = await manager.createBackup({ scope: "KNOWLEDGE", reason: "PRE_RESTORE" });

    repository.save({
      ...content,
      id: first.id,
      expectedVersion: 1,
      expectedRevisionId: first.revisionId,
      opId: "second",
      title: "第二版",
      bodyMarkdown: "# 第二版",
    });
    for (let index = 0; index < extra; index += 1) {
      await manager.createBackup({ scope: "KNOWLEDGE", reason: "PRE_RESTORE" });
    }

    const restored = await manager.restoreBackup(target.id);
    expect(restored.backup.id).toBe(target.id);
    const reopened = await manager.knowledge.open();
    expect(reopened.get(first.id).title).toBe("第一版");
  });
});

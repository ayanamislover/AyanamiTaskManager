import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AtmError } from "@ayanami-task/errors";
import { AyanamiDatabaseManager } from "../src/index.js";
import { discardDirectory } from "../src/storage-file-operations.js";

const temporary: string[] = [];
const managers: AyanamiDatabaseManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.close();
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDir(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), `atm-restore-cleanup-${prefix}-`));
  temporary.push(directory);
  return directory;
}

async function openManager(prefix: string) {
  const dataDir = temporaryDir(prefix);
  const manager = await AyanamiDatabaseManager.open({
    dataDir,
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  managers.push(manager);
  return { dataDir, manager };
}

describe("恢复收尾的清理只是尽力而为", () => {
  it("删不掉时不抛错，只回报没删成", () => {
    const failure = Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    const attempted: string[] = [];

    expect(
      discardDirectory("R:/不存在/.restore-XYZ", (target) => {
        attempted.push(target);
        throw failure;
      }),
    ).toBe(false);
    expect(attempted).toEqual(["R:/不存在/.restore-XYZ"]);
  });

  it("正文出错时，收尾的清理失败不会顶掉原来的错误", () => {
    const cleanupFailure = Object.assign(new Error("EPERM: operation not permitted"), {
      code: "EPERM",
    });

    // 恢复没提交就失败的那条路：finally 里的清理同样不能把真正的原因盖掉。
    expect(() => {
      try {
        throw new AtmError("BACKUP_INTEGRITY_FAILED", { message: "备份完整性检查失败" });
      } finally {
        discardDirectory("R:/不存在/.restore-XYZ", () => {
          throw cleanupFailure;
        });
      }
    }).toThrowError("备份完整性检查失败");
  });

  it("删得掉时回报删成了，目录真的不在了", () => {
    const root = temporaryDir("removable");
    const staging = join(root, ".restore-01");
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, "knowledge.sqlite"), "x");

    expect(discardDirectory(staging)).toBe(true);
    expect(existsSync(staging)).toBe(false);
  });

  /**
   * 上一次恢复如果没能删掉暂存目录（Windows 上有人还握着句柄就是 EPERM），
   * 下一次恢复既不能被它挡住，也不能拿它里面的残留文件当候选。
   */
  it("上一轮留下的暂存目录不挡住新的恢复", async () => {
    const { dataDir, manager } = await openManager("leftover");
    const repository = await manager.knowledge.open();
    const saved = repository.save({
      opId: "create",
      expectedVersion: 0,
      slug: "leftover",
      title: "第一版",
      summary: "残留暂存目录",
      bodyMarkdown: "# 第一版",
    });
    const target = await manager.createBackup({ scope: "KNOWLEDGE", reason: "MANUAL" });
    repository.save({
      ...{ slug: "leftover", summary: "残留暂存目录" },
      id: saved.id,
      expectedVersion: 1,
      expectedRevisionId: saved.revisionId,
      opId: "second",
      title: "第二版",
      bodyMarkdown: "# 第二版",
    });

    const staging = join(dataDir, "knowledge", `.restore-${target.id}`);
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, "knowledge.sqlite"), "上一轮留下的垃圾");

    const restored = await manager.restoreBackup(target.id);
    expect(restored.backup.id).toBe(target.id);
    const reopened = await manager.knowledge.open();
    expect(reopened.get(saved.id).title).toBe("第一版");
    expect(existsSync(staging)).toBe(false);
  });

  it("源码契约：知识库恢复的收尾走 discardDirectory，不再直接 rmSync", () => {
    const source = readFileSync(
      join(process.cwd(), "packages", "storage-sqlite", "src", "backup-restore.ts"),
      "utf8",
    );
    // 数据已经落地，收尾再抛异常就把一次成功的恢复报成了失败。
    expect(source).toContain("discardDirectory(stagingDirectory);");
    expect(source).not.toContain("rmSync(stagingDirectory");
    // 起手清场同样不能抛：删不掉就换一个目录接着做。
    expect(source).toMatch(/discardDirectory\(preferred\)\s*\?\s*preferred\s*:/u);
  });
});

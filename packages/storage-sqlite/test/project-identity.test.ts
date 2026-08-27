import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("项目身份", () => {
  it("同一真实目录的别名统一为一个身份，不合并不同目录", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-path-alias-"));
    temporary.push(root);
    const source = join(root, "source");
    const alias = join(root, "source-alias");
    const other = join(root, "other");
    mkdirSync(source);
    mkdirSync(other);
    symlinkSync(source, alias, "junction");
    const canonicalSource = realpathSync.native(source);
    const manager = await AyanamiDatabaseManager.open({
      dataDir: join(root, "data"),
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      // 阳性对照：夹具必须真的提供不同的词法表示，否则无法守住 8.3/长路径类回归。
      expect(resolve(alias)).not.toBe(canonicalSource);

      const project = await manager.createProject({ name: "路径别名", sourcePath: alias });
      expect(project.sourcePaths).toEqual([canonicalSource]);
      expect(manager.identifyProject(source)?.id).toBe(project.id);
      await expect(
        manager.createProject({ name: "重复路径", sourcePath: source }),
      ).rejects.toMatchObject({
        code: "PROJECT_ALREADY_EXISTS",
        details: { source_path: canonicalSource },
      });

      const distinct = await manager.createProject({ name: "不同目录", sourcePath: other });
      expect(distinct.id).not.toBe(project.id);
      expect(manager.identifyProject(other)?.id).toBe(distinct.id);
    } finally {
      manager.close();
    }
  });

  it("源码目录移动后通过 marker 重新识别同一项目", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-identity-"));
    temporary.push(root);
    const before = join(root, "before");
    const after = join(root, "after");
    mkdirSync(before);
    const manager = await AyanamiDatabaseManager.open({
      dataDir: join(root, "data"),
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      const project = await manager.createProject({ name: "路径移动", sourcePath: before });
      renameSync(before, after);
      expect(manager.identifyProject(after)?.id).toBe(project.id);
    } finally {
      manager.close();
    }
  });
});

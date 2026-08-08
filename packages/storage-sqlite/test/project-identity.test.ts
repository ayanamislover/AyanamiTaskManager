import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("项目身份", () => {
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

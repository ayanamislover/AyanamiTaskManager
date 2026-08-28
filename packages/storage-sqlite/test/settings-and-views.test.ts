import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import { isAtmError } from "@ayanami-task/errors";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager } from "../src/index.js";
import { captureAtmError } from "./typed-error-test-helpers.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function productionTypeScriptSources(): Array<{ file: string; source: string }> {
  return execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: process.cwd(),
    encoding: "utf8",
  })
    .split("\0")
    .filter((file) => /^(?:apps|packages)\/[^/]+\/src\/.*\.tsx?$/u.test(file))
    .map((file) => ({ file, source: readFileSync(resolve(process.cwd(), file), "utf8") }));
}

function getSettingLiteralKeys(file: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const keys: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text.replace(/^#/u, "") === "getSetting"
    ) {
      const key = node.arguments[0];
      if (key && (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key))) {
        keys.push(key.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return keys;
}

function rejectedSettingKeys(keys: readonly string[], write: (key: string) => unknown): string[] {
  return [...new Set(keys)].filter((key) => {
    try {
      write(key);
      return false;
    } catch (error) {
      if (isAtmError(error) && error.code === "SETTING_KEY_INVALID") return true;
      throw error;
    }
  });
}

describe("Registry 设置与保存视图", () => {
  it("持久化项目筛选并使用乐观版本防止静默覆盖", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-saved-views-"));
    temporary.push(dataDir);
    const manager = await AyanamiDatabaseManager.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      await manager.createProject({ name: "视图测试", sourcePath: null, code: "VIEW" });
      const created = manager.createSavedView({
        scope: "PROJECT",
        project: "VIEW",
        name: "需要处理",
        query: { statuses: ["BLOCKED", "WAITING_USER"] },
        sort: { field: "priority", direction: "desc" },
      });
      expect(created).toMatchObject({ projectCode: "VIEW", name: "需要处理", version: 0 });
      const updated = manager.updateSavedView(created.id, {
        expectedVersion: 0,
        name: "阻塞与等待",
        query: { status: "BLOCKED" },
        sort: {},
      });
      expect(updated).toMatchObject({ name: "阻塞与等待", version: 1 });
      expect(manager.listSavedViews("VIEW")).toEqual([
        expect.objectContaining({ id: created.id, version: 1 }),
      ]);
      expect(
        captureAtmError(() =>
          manager.updateSavedView(created.id, { expectedVersion: 0, name: "过期写入" }),
        ),
      ).toMatchObject({
        code: "VERSION_CONFLICT",
        details: { entity: "SAVED_VIEW", key: created.id, expected: 0, actual: 1 },
      });
    } finally {
      manager.close();
    }
  });

  it("设置写入可重试但不允许旧版本覆盖新值", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-settings-"));
    temporary.push(dataDir);
    const manager = await AyanamiDatabaseManager.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      const created = manager.setSetting("backup.policy", {
        enabled: true,
        dailyKeep: 7,
        weeklyKeep: 4,
      });
      expect(created).toMatchObject({ key: "backup.policy", version: 0, value: { enabled: true } });
      const updated = manager.setSetting("backup.policy", { enabled: false }, 0);
      expect(updated).toMatchObject({ version: 1, value: { enabled: false } });
      expect(
        captureAtmError(() => manager.setSetting("backup.policy", { enabled: true }, 0)),
      ).toMatchObject({
        code: "VERSION_CONFLICT",
        details: { entity: "SETTING", key: "backup.policy", expected: 0, actual: 1 },
      });
      expect(manager.listSettings()).toContainEqual(updated);
    } finally {
      manager.close();
    }
  });

  it("恢复会话超时键可通过统一设置入口读写", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-recovery-setting-"));
    temporary.push(dataDir);
    const manager = await AyanamiDatabaseManager.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      const created = manager.setSetting("recovery.sessionTimeoutMinutes", 15);

      expect(created).toMatchObject({
        key: "recovery.sessionTimeoutMinutes",
        value: 15,
        version: 0,
      });
      expect(manager.getSetting<number>("recovery.sessionTimeoutMinutes", 5).value).toBe(15);
    } finally {
      manager.close();
    }
  });

  it("通用驼峰键可写，但仍拒绝非法首字符和空格", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-mixed-case-setting-"));
    temporary.push(dataDir);
    const manager = await AyanamiDatabaseManager.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      expect(manager.setSetting("agent.maxRetryCount", 3)).toMatchObject({
        key: "agent.maxRetryCount",
        value: 3,
      });
      expect(
        captureAtmError(() => manager.setSetting("Invalid.firstCharacter", true)),
      ).toMatchObject({
        code: "SETTING_KEY_INVALID",
        details: { key: "Invalid.firstCharacter" },
      });
      expect(captureAtmError(() => manager.setSetting("invalid whitespace", true))).toMatchObject({
        code: "SETTING_KEY_INVALID",
        details: { key: "invalid whitespace" },
      });
    } finally {
      manager.close();
    }
  });

  it("静态守卫确保生产代码的 getSetting 字面量都可由 setSetting 写入", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-setting-key-guard-"));
    temporary.push(dataDir);
    const manager = await AyanamiDatabaseManager.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    try {
      const literalKeys = productionTypeScriptSources().flatMap(({ file, source }) =>
        getSettingLiteralKeys(file, source),
      );
      const rejected = rejectedSettingKeys(literalKeys, (key) => manager.setSetting(key, null));

      expect(literalKeys).toContain("recovery.sessionTimeoutMinutes");
      expect(rejected).toEqual([]);

      // 阳性对照：扫描器能发现非法字面量，且会经同一写入校验稳定变红。
      const invalidFixture = getSettingLiteralKeys(
        "invalid-setting.ts",
        'service.getSetting("contains whitespace", null);',
      );
      expect(invalidFixture).toEqual(["contains whitespace"]);
      expect(
        getSettingLiteralKeys(
          "invalid-private-setting.ts",
          'class Fixture { #getSetting() {} read() { this.#getSetting("private whitespace", null); } }',
        ),
      ).toEqual(["private whitespace"]);
      expect(rejectedSettingKeys(invalidFixture, (key) => manager.setSetting(key, null))).toEqual([
        "contains whitespace",
      ]);
    } finally {
      manager.close();
    }
  });
});

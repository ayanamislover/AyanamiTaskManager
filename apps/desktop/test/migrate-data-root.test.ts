import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiTaskService } from "../../../packages/application/src/index.js";
import { migrateDataRoot } from "../../../scripts/migrate-data-root.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("正式数据根迁移", () => {
  it("保留空目标备份、目标 token 并重写项目数据库路径", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-data-migration-"));
    roots.push(root);
    const source = join(root, "visual-data");
    const destination = join(root, "AyanamiTaskManager");
    const migrationsRoot = join(process.cwd(), "migrations");
    const sourceService = await AyanamiTaskService.open({ dataDir: source, migrationsRoot });
    await sourceService.createProject({ name: "历史项目", code: "HIS", sourcePath: null });
    sourceService.close();
    const destinationService = await AyanamiTaskService.open({
      dataDir: destination,
      migrationsRoot,
    });
    destinationService.close();
    mkdirSync(join(source, "runtime"), { recursive: true });
    mkdirSync(join(destination, "runtime"), { recursive: true });
    writeFileSync(join(source, "runtime", "local.token"), "source-token", "utf8");
    writeFileSync(join(destination, "runtime", "local.token"), "destination-token", "utf8");

    const result = await migrateDataRoot({
      source,
      destination,
      execute: true,
      timestamp: "2026-08-08T00:00:00.000Z",
    });
    expect(result.executed).toBe(true);
    expect(result.destinationBackup && existsSync(result.destinationBackup)).toBe(true);
    expect(readFileSync(join(destination, "runtime", "local.token"), "utf8")).toBe(
      "destination-token",
    );
    const migrated = await AyanamiTaskService.open({ dataDir: destination, migrationsRoot });
    const project = migrated.databases.getProject("HIS");
    expect(project.databasePath.startsWith(destination)).toBe(true);
    expect(migrated.databases.listProjects()).toHaveLength(1);
    migrated.close();
    expect(existsSync(join(destination, "migration-manifest.json"))).toBe(true);
  });

  it("迁移数据根时跳过 current junction，不复制或展开安装目录", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-data-junction-"));
    roots.push(root);
    const source = join(root, "source");
    const destination = join(root, "destination");
    const installRoot = join(root, "installed-app");
    const migrationsRoot = join(process.cwd(), "migrations");
    mkdirSync(installRoot, { recursive: true });
    writeFileSync(join(installRoot, "chromium-payload.bin"), "must-not-be-copied", "utf8");
    const sourceService = await AyanamiTaskService.open({ dataDir: source, migrationsRoot });
    await sourceService.createProject({ name: "链接边界", code: "LINK", sourcePath: null });
    sourceService.close();
    symlinkSync(installRoot, join(source, "current"), "junction");

    await migrateDataRoot({
      source,
      destination,
      execute: true,
      timestamp: "2026-08-26T00:00:00.000Z",
    });

    expect(existsSync(join(destination, "current"))).toBe(false);
    expect(existsSync(join(destination, "chromium-payload.bin"))).toBe(false);
    expect(existsSync(join(installRoot, "chromium-payload.bin"))).toBe(true);
  });
});

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const dataDir = mkdtempSync(join(tmpdir(), `atm-backup-health-${prefix}-`));
  temporary.push(dataDir);
  const manager = await AyanamiDatabaseManager.open({
    dataDir,
    migrationsRoot: resolve(process.cwd(), "migrations"),
  });
  managers.push(manager);
  return { dataDir, manager };
}

describe("去重复用只认健康的旧备份", () => {
  it("旧文件内容损坏时不复用：保留新快照，旧的那份不再被登记", async () => {
    const { manager } = await openManager("corrupt");
    const project = await manager.createProject({ name: "损坏", sourcePath: null, code: "COR" });
    const first = await manager.createBackup({
      scope: "PROJECT",
      project: project.id,
      reason: "DAILY",
      createdAt: "2026-09-01T10:00:00.000Z",
    });
    // 只破坏盘上的文件，目录表里的 sha256 保持不变——这正是「看着能复用、其实恢复不了」的状态。
    writeFileSync(first.path, "corrupted");

    const second = await manager.createBackup({
      scope: "PROJECT",
      project: project.id,
      reason: "DAILY",
      createdAt: "2026-09-02T10:00:00.000Z",
    });
    expect(second.id).not.toBe(first.id);
    expect(existsSync(second.path)).toBe(true);
    // 新快照必须自己是完整的：哈希与清单都能对上。
    const manifest = JSON.parse(readFileSync(`${second.path}.manifest.json`, "utf8")) as {
      sha256: string;
      id: string;
    };
    expect(manifest.id).toBe(second.id);
    expect(manifest.sha256).toBe(second.sha256);
    await expect(manager.restoreBackup(second.id)).resolves.toMatchObject({
      backup: { id: second.id },
    });
  });

  it("旧清单缺失或对不上时不复用", async () => {
    for (const [prefix, breakManifest] of [
      ["missing", (path: string) => rmSync(`${path}.manifest.json`, { force: true })],
      [
        "mismatch",
        (path: string) =>
          writeFileSync(`${path}.manifest.json`, JSON.stringify({ id: "别的备份" }), "utf8"),
      ],
    ] as const) {
      const { manager } = await openManager(prefix);
      const project = await manager.createProject({
        name: "清单",
        sourcePath: null,
        code: "MAN",
      });
      const first = await manager.createBackup({
        scope: "PROJECT",
        project: project.id,
        reason: "DAILY",
        createdAt: "2026-09-01T10:00:00.000Z",
      });
      breakManifest(first.path);

      const second = await manager.createBackup({
        scope: "PROJECT",
        project: project.id,
        reason: "DAILY",
        createdAt: "2026-09-02T10:00:00.000Z",
      });
      expect(second.id, prefix).not.toBe(first.id);
      expect(existsSync(`${second.path}.manifest.json`), prefix).toBe(true);
    }
  });

  it("旧备份健康时照旧复用，不多存一份", async () => {
    const { manager } = await openManager("healthy");
    const project = await manager.createProject({ name: "健康", sourcePath: null, code: "OK" });
    const first = await manager.createBackup({
      scope: "PROJECT",
      project: project.id,
      reason: "DAILY",
      createdAt: "2026-09-01T10:00:00.000Z",
    });
    const second = await manager.createBackup({
      scope: "PROJECT",
      project: project.id,
      reason: "DAILY",
      createdAt: "2026-09-02T10:00:00.000Z",
    });
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe("2026-09-02T10:00:00.000Z");
  });
});

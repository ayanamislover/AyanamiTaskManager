import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  /**
   * JSON.parse("null") 不抛错，返回的就是 null；再读属性才抛 TypeError。而这个判断跑在
   * 「新快照已经落盘」之后，异常会被 createBackup 的 catch 当成本次备份失败回滚掉。
   * 数组、标量、半截 JSON 都是同一个形状的问题，一并覆盖。
   */
  it.each(["null", "[]", "123", '"字符串"', "{半截"])(
    "旧清单是 %s 时也只是不复用，不能把刚做好的新备份连带撤销",
    async (manifestText) => {
      const { manager } = await openManager("odd-manifest");
      const project = await manager.createProject({
        name: "怪清单",
        sourcePath: null,
        code: "NUL",
      });
      const first = await manager.createBackup({
        scope: "PROJECT",
        project: project.id,
        reason: "DAILY",
        createdAt: "2026-09-01T10:00:00.000Z",
      });
      writeFileSync(`${first.path}.manifest.json`, manifestText, "utf8");

      const second = await manager.createBackup({
        scope: "PROJECT",
        project: project.id,
        reason: "DAILY",
        createdAt: "2026-09-02T10:00:00.000Z",
      });
      expect(second.id).not.toBe(first.id);
      expect(existsSync(second.path)).toBe(true);
      expect(existsSync(`${second.path}.manifest.json`)).toBe(true);
      // 新备份必须真正登记成功，而且恢复得回来，不是被当成一次失败回滚掉。
      expect(manager.listBackups(project.id).map((backup) => backup.id)).toContain(second.id);
      expect(
        manager.registry.sqlite
          .prepare("SELECT COUNT(*) AS count FROM global_events WHERE type = 'backup.failed'")
          .get(),
      ).toEqual({ count: 0 });
      await expect(manager.restoreBackup(second.id)).resolves.toMatchObject({
        backup: { id: second.id },
      });
    },
  );

  it("旧备份连读都读不出来时也只是不复用，不能把刚做好的新备份连带撤销", async () => {
    const { manager } = await openManager("unreadable");
    const project = await manager.createProject({ name: "读不出", sourcePath: null, code: "IOE" });
    const first = await manager.createBackup({
      scope: "PROJECT",
      project: project.id,
      reason: "DAILY",
      createdAt: "2026-09-01T10:00:00.000Z",
    });
    // 路径还在、目录表也还指着它，但它已经不是一个能读的文件了——读它会抛 EISDIR。
    rmSync(first.path, { force: true });
    mkdirSync(first.path, { recursive: true });

    const second = await manager.createBackup({
      scope: "PROJECT",
      project: project.id,
      reason: "DAILY",
      createdAt: "2026-09-02T10:00:00.000Z",
    });
    expect(second.id).not.toBe(first.id);
    expect(manager.listBackups(project.id).map((backup) => backup.id)).toContain(second.id);
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

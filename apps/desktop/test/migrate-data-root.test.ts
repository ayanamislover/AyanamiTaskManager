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
  it("保留空目标备份、清理两套旧运行时发现文件并重写项目数据库路径", async () => {
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
    writeFileSync(
      join(source, "runtime", "daemon.json"),
      JSON.stringify({ token: "source-runtime-token" }),
      "utf8",
    );
    writeFileSync(
      join(destination, "runtime", "daemon.json"),
      JSON.stringify({ token: "destination-runtime-token" }),
      "utf8",
    );

    const result = await migrateDataRoot({
      source,
      destination,
      execute: true,
      timestamp: "2026-08-08T00:00:00.000Z",
    });
    expect(result.executed).toBe(true);
    expect(result.destinationBackup && existsSync(result.destinationBackup)).toBe(true);
    expect(existsSync(join(destination, "runtime", "local.token"))).toBe(false);
    expect(existsSync(join(destination, "runtime", "daemon.json"))).toBe(false);
    expect(
      result.destinationBackup &&
        existsSync(join(result.destinationBackup, "runtime", "local.token")),
    ).toBe(false);
    expect(
      result.destinationBackup &&
        existsSync(join(result.destinationBackup, "runtime", "daemon.json")),
    ).toBe(false);
    const migrated = await AyanamiTaskService.open({ dataDir: destination, migrationsRoot });
    const project = migrated.databases.getProject("HIS");
    expect(project.databasePath.startsWith(destination)).toBe(true);
    expect(migrated.databases.listProjects()).toHaveLength(1);
    migrated.close();
    expect(existsSync(join(destination, "migration-manifest.json"))).toBe(true);
    await expect(
      migrateDataRoot({
        source,
        destination,
        execute: true,
        timestamp: "2030-01-01T00:00:00.000Z",
      }),
    ).resolves.toEqual(result);
  });

  it("copy、manifest、backup 或 commit 后中断都可幂等重试且不留下 token", async () => {
    for (const stage of ["AFTER_COPY", "AFTER_MANIFEST", "AFTER_BACKUP", "AFTER_COMMIT"] as const) {
      const root = mkdtempSync(join(tmpdir(), `atm-data-retry-${stage.toLowerCase()}-`));
      roots.push(root);
      const source = join(root, "source");
      const destination = join(root, "destination");
      const migrationsRoot = join(process.cwd(), "migrations");
      const sourceService = await AyanamiTaskService.open({ dataDir: source, migrationsRoot });
      await sourceService.createProject({
        name: stage,
        code: `R${roots.length}`,
        sourcePath: null,
      });
      sourceService.close();
      const destinationService = await AyanamiTaskService.open({
        dataDir: destination,
        migrationsRoot,
      });
      destinationService.close();
      mkdirSync(join(source, "runtime"), { recursive: true });
      mkdirSync(join(destination, "runtime"), { recursive: true });
      writeFileSync(join(source, "runtime", "local.token"), "source-sentinel-secret", "utf8");
      writeFileSync(
        join(destination, "runtime", "local.token"),
        "destination-sentinel-secret",
        "utf8",
      );
      writeFileSync(
        join(source, "runtime", "daemon.json"),
        JSON.stringify({ token: "source-daemon-sentinel-secret" }),
        "utf8",
      );
      writeFileSync(
        join(destination, "runtime", "daemon.json"),
        JSON.stringify({ token: "destination-daemon-sentinel-secret" }),
        "utf8",
      );
      let injected = false;
      await expect(
        migrateDataRoot({
          source,
          destination,
          execute: true,
          timestamp: `2026-08-28T00:00:0${roots.length}.000Z`,
          onStage(current) {
            if (current === stage && !injected) {
              injected = true;
              throw new Error(`INJECTED_${stage}`);
            }
          },
        }),
      ).rejects.toThrow(`INJECTED_${stage}`);

      const retried = await migrateDataRoot({ source, destination, execute: true });
      expect(retried.executed).toBe(true);
      expect(existsSync(join(destination, "runtime", "local.token"))).toBe(false);
      expect(existsSync(join(destination, "runtime", "daemon.json"))).toBe(false);
      if (retried.destinationBackup)
        expect(existsSync(join(retried.destinationBackup, "runtime", "local.token"))).toBe(false);
      if (retried.destinationBackup)
        expect(existsSync(join(retried.destinationBackup, "runtime", "daemon.json"))).toBe(false);
      const manifest = readFileSync(join(destination, "migration-manifest.json"), "utf8");
      expect(manifest).not.toContain("sentinel-secret");
      await expect(migrateDataRoot({ source, destination, execute: true })).resolves.toEqual(
        retried,
      );
    }
  });

  it("并发迁移只有一个提交者，另一方明确返回进行中", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-data-concurrent-"));
    roots.push(root);
    const source = join(root, "source");
    const destination = join(root, "destination");
    const migrationsRoot = join(process.cwd(), "migrations");
    const sourceService = await AyanamiTaskService.open({ dataDir: source, migrationsRoot });
    await sourceService.createProject({ name: "并发迁移", code: "CMG", sourcePath: null });
    sourceService.close();
    let releaseCopy!: () => void;
    const holdCopy = new Promise<void>((resolveCopy) => {
      releaseCopy = resolveCopy;
    });
    let reachedCopy!: () => void;
    const copyReached = new Promise<void>((resolveReached) => {
      reachedCopy = resolveReached;
    });
    const first = migrateDataRoot({
      source,
      destination,
      execute: true,
      async onStage(stage) {
        if (stage === "AFTER_COPY") {
          reachedCopy();
          await holdCopy;
        }
      },
    });
    await copyReached;
    await expect(migrateDataRoot({ source, destination, execute: true })).rejects.toThrow(
      "MIGRATION_IN_PROGRESS",
    );
    releaseCopy();
    await expect(first).resolves.toMatchObject({ executed: true, projects: 1 });
  });

  it("拒绝互相嵌套的数据根", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-data-nested-"));
    roots.push(root);
    await expect(
      migrateDataRoot({ source: root, destination: join(root, "nested"), execute: false }),
    ).rejects.toThrow("DATA_ROOTS_MUST_NOT_NEST");
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

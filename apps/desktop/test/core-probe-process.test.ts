import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { APP_LAYOUT, assembleAppDirectory } from "../../../scripts/app-layout.js";

/**
 * 安装事务的只读探测（de-electron §6 第 4 步），真实进程：安装根下的 app-9.9.9 版本目录、
 * 持有安装锁的「setup」（PowerShell 以 FileShare.None 打开 install.lock）、假宿主。
 */
const root = process.cwd();
const version = "9.9.9";
let work = "";
let installRoot = "";
let appDir = "";
let locker: ChildProcess | null = null;

beforeAll(() => {
  execFileSync(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "apps/desktop/scripts/build-core.ts"],
    {
      cwd: root,
      stdio: "ignore",
    },
  );
  mkdirSync(resolve(root, "output"), { recursive: true });
  work = mkdtempSync(join(resolve(root, "output"), "core-probe-"));
  installRoot = join(work, "install");
  appDir = assembleAppDirectory({
    root,
    target: join(installRoot, `app-${version}`),
    hostExe: process.execPath,
    nodeExe: process.execPath,
  });
  mkdirSync(join(installRoot, "state"), { recursive: true });
  writeFileSync(join(installRoot, "app.json"), JSON.stringify({ current: "1.0.0" }));
}, 120_000);

afterEach(async () => {
  await releaseLock();
});

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

function journal(fields: Record<string, unknown>): void {
  writeFileSync(
    join(installRoot, "state", "install.json"),
    JSON.stringify({ id: "txn-1", from: "1.0.0", to: version, state: "PROBE", ...fields }),
  );
}

/** setup 持锁的方式：独占打开（share mode 0），进程在锁就在。 */
async function holdLock(): Promise<void> {
  const lock = join(installRoot, "state", "install.lock").replaceAll("'", "''");
  locker = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$f = [System.IO.File]::Open('${lock}', 'OpenOrCreate', 'ReadWrite', 'None'); ` +
        `[Console]::Out.WriteLine('held'); [void][Console]::In.ReadLine(); $f.Close()`,
    ],
    { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
  );
  await new Promise<void>((done, fail) => {
    locker!.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      if (chunk.includes("held")) done();
    });
    locker!.once("exit", () => fail(new Error("lock holder exited")));
  });
}

async function releaseLock(): Promise<void> {
  if (!locker) return;
  const exiting = new Promise((done) => locker!.once("exit", done));
  locker.stdin!.end("\n");
  await exiting;
  locker = null;
}

function runFakeHost(dataDir: string, mode: "shutdown" | "probe", txn = "txn-1") {
  const result = spawnSync(
    join(appDir, APP_LAYOUT.host),
    [
      resolve(root, "apps/desktop/test/fixtures/fake-host.mjs"),
      join(appDir, APP_LAYOUT.coreExe),
      join(appDir, APP_LAYOUT.coreBundle),
      mode,
      txn,
    ],
    { encoding: "utf8", timeout: 60_000, env: { ...process.env, ATM_DATA_DIR: dataDir } },
  );
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  return JSON.parse(line || "{}") as Record<string, any>;
}

/** 数据根下每个文件的相对路径、大小、mtime、内容哈希。 */
function fingerprint(directory: string, prefix = ""): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return fingerprint(path, `${prefix}${entry.name}/`);
      const stat = statSync(path);
      const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
      return [`${prefix}${entry.name} ${stat.size} ${stat.mtimeMs} ${hash}`];
    });
}

/** 先按正常方式跑一次，建出 registry 与发现文件等真实数据根。 */
function seededDataDir(name: string): string {
  const dataDir = join(work, name);
  expect(runFakeHost(dataDir, "shutdown").exitCode).toBe(0);
  return dataDir;
}

describe("安装探测（core 只读模式）", () => {
  it("持锁的 PROBE 事务：核对迁移并回 probed，数据根一个字节、一个 mtime 都不变", async () => {
    const dataDir = seededDataDir("data-probe-ok");
    const before = fingerprint(dataDir);
    journal({});
    await holdLock();
    const result = runFakeHost(dataDir, "probe");
    expect(result.probed, result.stderr).toMatchObject({
      t: "probed",
      ok: true,
      databases: [expect.objectContaining({ scope: "registry", applied: 8, mode: "snapshot" })],
    });
    // 只读：没有 ready（没开服务），0 退出。
    expect(result.frames).toEqual(["probed"]);
    expect(result.exitCode).toBe(0);
    expect(fingerprint(dataDir)).toEqual(before);
  }, 120_000);

  it("库里有随包集合之外的迁移（例如从更新的版本回退）：probed ok=false 带原因", async () => {
    const dataDir = seededDataDir("data-probe-future");
    const database = new Database(join(dataDir, "registry", "registry.sqlite"));
    database
      .prepare(
        `INSERT INTO schema_migrations(version, name, applied_at, content_sha256, hash_origin)
         VALUES (99, '0099_from_the_future.sql', '2026-09-30T00:00:00.000Z', 'x', 'APPLIED')`,
      )
      .run();
    database.close();
    journal({});
    await holdLock();
    const result = runFakeHost(dataDir, "probe");
    expect(result.probed, result.stderr).toEqual({
      t: "probed",
      ok: false,
      code: "MIGRATION_FILE_MISSING",
      scope: "registry",
    });
    expect(result.exitCode).toBe(0);
  }, 120_000);

  for (const [label, setup] of [
    ["没人持锁（setup 已死）", async () => journal({})],
    ["事务 id 对不上", async () => (journal({ id: "txn-other" }), holdLock())],
    ["事务不在 PROBE", async () => (journal({ state: "START" }), holdLock())],
    ["目标不是本版本", async () => (journal({ to: "8.8.8" }), holdLock())],
  ] as const) {
    it(`${label}：probe 参数不授予任何能力，core 以 64 拒绝`, async () => {
      const dataDir = join(
        work,
        `data-unbound-${label.length}-${Math.random().toString(36).slice(2)}`,
      );
      await setup();
      const result = runFakeHost(dataDir, "probe");
      expect(result.probed ?? null).toBeNull();
      expect(result.exitCode).toBe(64);
      expect(result.stderr).toContain("ATM_CORE_PROBE_UNBOUND");
    }, 120_000);
  }
});

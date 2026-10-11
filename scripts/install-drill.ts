/**
 * 安装/更新/迁移/回滚演练（ATM-T-0554，de-electron §6、§9）。全部在沙箱里：
 *
 *   output/drill/<场景>/install     安装根（ATM_SETUP_SANDBOX 把它、快捷方式目录一起换走）
 *   output/drill/<场景>/data        数据根 L（ATM_DATA_DIR）
 *   output/drill/<场景>/v3-data     3.x 根 N（ATM3_DATA_DIR；不设的话 3.x 宿主会落到真实的
 *                                   %LOCALAPPDATA%\AyanamiTaskManager3）
 *   HKCU\Software\AyanamiTaskManagerDrill\<hash>\  Uninstall 与 Run（结束时删掉）
 *
 * 用的是 drill 构建的 setup（带沙箱与故障注入）；真实安装根、真实注册表和用户正在跑的 ATM
 * 都碰不到。Electron 1.x 用 setup/examples/fake-electron.rs 代替：真 Electron 在沙箱里会和
 * 用户在跑的那一份抢同一把单实例锁。
 *
 *   pnpm exec tsx scripts/install-drill.ts            # 需要已构建的原生产物与 renderer/core
 *   pnpm exec tsx scripts/install-drill.ts --only update,faults
 *
 * 2.0 ⇄ 3.0 的场景（v2-v3、v2-v3-faults）还要一份 2.0 时代 drill 构建的包：
 * output/drill/package-2.0.0/{atm-setup.exe, atm-2.0.0-win-x64.json, atm-2.0.0-win-x64.zip}。
 * 它不在仓库里：从 2.0 的检出（v2.0.0）里 `package-native.ts --drill output/drill/package-2.0.0
 * --drill-version 2.0.0` 打一份，或者复制 2.0 时代演练留下的那份。生产 2.0 的 setup 没有沙箱，不能用。
 */
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  openSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { legacyBusiness, sameBusiness, v3Business, type Business } from "./business-summary.js";
import { NATIVE_CRATE_DIR, packageNative } from "./package-native.js";

const root = resolve(process.cwd());
const drillRoot = resolve(root, "output", "drill");
const VERSION_A = "9.0.0";
const VERSION_B = "9.0.1";
/** The fake Electron install; any version below the drill packages (not the real one). */
const LEGACY = "1.9.0";
/** An older Electron version directory Squirrel leaves behind, produced mid-migration. */
const SQUIRREL_ADDED = "app-1.8.9";
const AUMID = "com.squirrel.AyanamiTaskManagerDesktop.AyanamiTaskManager";
const TOAST_CLSID = "{69f12b18-2bbb-5b7a-98b5-b8f0246b08a6}";
const fakeElectron = join(
  root,
  NATIVE_CRATE_DIR,
  "target-drill",
  "release",
  "examples",
  "fake-electron.exe",
);
const jobRunner = join(
  root,
  NATIVE_CRATE_DIR,
  "target-drill",
  "release",
  "examples",
  "job-runner.exe",
);

type Pointer = { current: string; previous?: string | null };
type Journal = {
  id: string;
  state: string;
  outcome?: string | null;
  kind?: string;
  commitPending?: boolean;
  undo?: { target: string; step: number } | null;
  started?: { pid: number } | null;
};

const results: Array<{ scenario: string; check: string; passed: boolean; detail?: string }> = [];
let currentScenario = "";

function check(name: string, passed: boolean, detail?: unknown): void {
  results.push({
    scenario: currentScenario,
    check: name,
    passed,
    ...(passed || detail === undefined ? {} : { detail: JSON.stringify(detail).slice(0, 400) }),
  });
  process.stdout.write(
    `  ${passed ? "✓" : "✗"} ${name}${passed ? "" : `  ${JSON.stringify(detail)?.slice(0, 300)}`}\n`,
  );
}

/** Same FNV-1a as setup's Env::sandboxed, over the lower-cased path. */
function registryBase(sandbox: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(sandbox.toLowerCase(), "utf8")) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `HKCU\\Software\\AyanamiTaskManagerDrill\\${hash.toString(16).padStart(16, "0")}`;
}

class Sandbox {
  readonly dir: string;
  readonly install: string;
  readonly data: string;
  /** N: the 3.x root. */
  readonly v3: string;
  readonly registry: string;
  constructor(name: string) {
    this.dir = join(drillRoot, name);
    this.install = join(this.dir, "install");
    this.data = join(this.dir, "data");
    this.v3 = join(this.dir, "v3-data");
    this.registry = registryBase(this.dir);
  }
  env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ATM_SETUP_SANDBOX: this.dir,
      ATM_DATA_DIR: this.data,
      ATM3_DATA_DIR: this.v3,
      // 合成的 LOCALAPPDATA / APPDATA：宿主、WebView2 与任何按已知文件夹找东西的代码都落在沙箱里。
      LOCALAPPDATA: join(this.dir, "localappdata"),
      APPDATA: join(this.dir, "appdata"),
      ...extra,
    };
    for (const key of [
      "ATM_SETUP_DIE_AFTER",
      "ATM_SETUP_FAIL_AT",
      "ATM_SETUP_FAIL_UNDO",
      "ATM_SETUP_SQUIRREL_ADDS",
      "ATM_SETUP_PAUSE_UNLOCKED",
      "ATM_SETUP_WAIT_SECS",
    ])
      if (!(key in extra)) delete env[key];
    return env;
  }
  pointer(): Pointer | null {
    const path = join(this.install, "app.json");
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Pointer) : null;
  }
  journal(): Journal | null {
    const path = join(this.install, "state", "install.json");
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Journal) : null;
  }
  /**
   * Version the running service publishes: a 2.x core in `L\runtime\daemon.json`, a 3.x
   * host in `N\runtime\daemon.json`. Only a descriptor whose pid is alive in the sandbox
   * counts (the other root may keep a stale one). The token field is never read out.
   */
  serviceVersion(): string | null {
    const alive = processes(this.dir);
    for (const runtime of [join(this.v3, "runtime"), join(this.data, "runtime")]) {
      const path = join(runtime, "daemon.json");
      if (!existsSync(path)) continue;
      try {
        const { version, pid } = JSON.parse(readFileSync(path, "utf8")) as {
          version: string;
          pid: number;
        };
        if (alive.some((proc) => proc.pid === pid)) return version;
      } catch {
        // Being rewritten; the next poll reads it.
      }
    }
    return null;
  }
  log(lines = 12): string {
    const path = join(this.install, "state", "setup.log");
    return existsSync(path)
      ? readFileSync(path, "utf8").trim().split("\n").slice(-lines).join("\n")
      : "";
  }
  /** A mark in setup.log; `since(mark)` is everything logged after it. */
  logMark(): number {
    const path = join(this.install, "state", "setup.log");
    return existsSync(path) ? readFileSync(path, "utf8").length : 0;
  }
  since(mark: number): string {
    const path = join(this.install, "state", "setup.log");
    return existsSync(path) ? readFileSync(path, "utf8").slice(mark) : "";
  }
}

function processes(prefix: string): Array<{ pid: number; path: string }> {
  const script =
    "Get-Process | Where-Object { $_.Path } | ForEach-Object { [pscustomobject]@{ pid = $_.Id; path = $_.Path } } | ConvertTo-Json -Compress";
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const parsed = JSON.parse(result.stdout.trim() || "[]") as unknown;
  const list = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{ pid: number; path: string }>;
  return list.filter((proc) => proc.path?.toLowerCase().startsWith(prefix.toLowerCase()));
}

function killAll(prefix: string): void {
  for (const proc of processes(prefix))
    spawnSync("taskkill.exe", ["/F", "/PID", String(proc.pid)], {
      windowsHide: true,
      stdio: "ignore",
    });
}

function runSetup(
  sandbox: Sandbox,
  setup: string,
  args: string[],
  extra: Record<string, string> = {},
): number {
  const result = spawnSync(setup, args, {
    env: sandbox.env(extra),
    stdio: "ignore",
    windowsHide: true,
    timeout: 240_000,
  });
  return result.status ?? -1;
}

function runLauncher(sandbox: Sandbox, args: string[]): SpawnSyncReturns<string> {
  return spawnSync(join(sandbox.install, "AyanamiTaskManager.exe"), args, {
    env: sandbox.env(),
    encoding: "utf8",
    windowsHide: true,
    timeout: 240_000,
  });
}

async function until(predicate: () => boolean, ms = 30_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(250);
  }
  return predicate();
}

function reg(args: string[]): SpawnSyncReturns<string> {
  return spawnSync("reg.exe", args, { encoding: "utf8", windowsHide: true });
}

function regValue(key: string, name: string): string | null {
  const result = reg(["query", key, "/v", name]);
  if (result.status !== 0) return null;
  const line = result.stdout.split(/\r?\n/u).find((row) => row.trim().startsWith(name));
  return line
    ? line
        .trim()
        .split(/\s{4,}/u)
        .slice(2)
        .join("    ")
    : null;
}

function shortcut(path: string): Record<string, string> | null {
  if (!existsSync(path)) return null;
  const literal = path.replaceAll("'", "''");
  const script = `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${literal}'); [pscustomobject]@{ target = $s.TargetPath; args = $s.Arguments; workdir = $s.WorkingDirectory } | ConvertTo-Json -Compress`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true },
  );
  return JSON.parse(result.stdout.trim() || "null") as Record<string, string> | null;
}

/** AppUserModel.ID and ToastActivatorCLSID via the Shell property system. */
function shortcutIdentity(path: string): { aumid: string; toast: string } {
  const literal = path.replaceAll("'", "''");
  const script =
    `$shell = New-Object -ComObject Shell.Application; $folder = $shell.Namespace((Split-Path '${literal}')); ` +
    `$item = $folder.ParseName((Split-Path '${literal}' -Leaf)); ` +
    `[pscustomobject]@{ aumid = [string]$item.ExtendedProperty('System.AppUserModel.ID'); toast = [string]$item.ExtendedProperty('System.AppUserModel.ToastActivatorCLSID') } | ConvertTo-Json -Compress`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true },
  );
  return JSON.parse(result.stdout.trim() || '{"aumid":"","toast":""}') as {
    aumid: string;
    toast: string;
  };
}

function junctionTarget(link: string): string | null {
  const script = `$i = Get-Item '${link.replaceAll("'", "''")}' -Force -ErrorAction SilentlyContinue; if ($i -and $i.LinkType) { [string]$i.Target }`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true },
  );
  return result.stdout.trim() || null;
}

function samePath(left: string | null, right: string): boolean {
  return (
    (left ?? "").replace(/[\\/]+$/u, "").toLowerCase() ===
    right.replace(/[\\/]+$/u, "").toLowerCase()
  );
}

function reset(sandbox: Sandbox): void {
  killAll(sandbox.dir);
  reg(["delete", sandbox.registry, "/f"]);
  rmSync(sandbox.dir, { recursive: true, force: true });
  mkdirSync(join(sandbox.dir, "localappdata"), { recursive: true });
  mkdirSync(join(sandbox.dir, "appdata"), { recursive: true });
}

function teardown(sandbox: Sandbox): void {
  killAll(sandbox.dir);
  reg(["delete", sandbox.registry, "/f"]);
}

function packages(rebuild: boolean): {
  a: { setup: string; manifest: string };
  b: { setup: string; manifest: string };
} {
  const out = (version: string) => join(drillRoot, `package-${version}`);
  for (const version of [VERSION_A, VERSION_B])
    if (rebuild || !existsSync(join(out(version), `atm-${version}-win-x64.json`)))
      packageNative({
        root,
        build: false,
        drill: true,
        drillVersion: version,
        outDir: out(version),
      });
  const at = (version: string) => ({
    setup: join(out(version), "atm-setup.exe"),
    manifest: join(out(version), `atm-${version}-win-x64.json`),
  });
  return { a: at(VERSION_A), b: at(VERSION_B) };
}

type Packages = ReturnType<typeof packages>;

async function installed(
  sandbox: Sandbox,
  version: string,
  previous: string | null,
): Promise<void> {
  const pointer = sandbox.pointer();
  check(
    `app.json = {current: ${version}, previous: ${previous}}`,
    pointer?.current === version && (pointer.previous ?? null) === previous,
    pointer,
  );
  check(
    `service running ${version}`,
    await until(() => sandbox.serviceVersion() === version, 20_000),
    sandbox.serviceVersion(),
  );
  const journal = sandbox.journal();
  check(
    "journal terminal COMMITTED, not pending",
    journal?.state === "DONE" && journal.outcome === "COMMITTED" && !journal.commitPending,
    journal,
  );
  check(
    "current → install root",
    samePath(junctionTarget(join(sandbox.data, "current")), sandbox.install),
    junctionTarget(join(sandbox.data, "current")),
  );
}

async function scenarioLifecycle(pkg: Packages): Promise<void> {
  currentScenario = "lifecycle";
  const sandbox = new Sandbox("lifecycle");
  reset(sandbox);
  process.stdout.write(`\n[${currentScenario}] first install ${VERSION_A}\n`);
  let started = Date.now();
  check(
    "install exit 0",
    runSetup(sandbox, pkg.a.setup, ["install", pkg.a.manifest, "--quiet"]) === 0,
    sandbox.log(),
  );
  check(
    `install took ${((Date.now() - started) / 1000).toFixed(1)}s (< 30s)`,
    Date.now() - started < 30_000,
  );
  await installed(sandbox, VERSION_A, null);
  const startMenu = join(sandbox.dir, "start-menu", "ayanami", "AyanamiTaskManager.lnk");
  const link = shortcut(startMenu);
  check(
    "start-menu shortcut → root launcher, workdir install root",
    samePath(link?.target ?? null, join(sandbox.install, "AyanamiTaskManager.exe")) &&
      samePath(link?.workdir ?? null, sandbox.install),
    link,
  );
  check(
    "start-menu shortcut carries the Squirrel AUMID and toast activator",
    shortcutIdentity(startMenu).aumid === AUMID &&
      shortcutIdentity(startMenu).toast.toLowerCase() === TOAST_CLSID,
    shortcutIdentity(startMenu),
  );
  check(
    "first install creates a desktop shortcut",
    existsSync(join(sandbox.dir, "desktop", "AyanamiTaskManager.lnk")),
  );
  check(
    "repair shortcut → atm-setup --repair",
    shortcut(join(sandbox.dir, "start-menu", "ayanami", "ATM 修复.lnk"))?.args === "--repair",
  );
  const uninstallKey = `${sandbox.registry}\\Uninstall\\AyanamiTaskManagerDesktop`;
  check(
    "Uninstall key points at atm-setup",
    (regValue(uninstallKey, "UninstallString") ?? "").includes('atm-setup.exe" --uninstall'),
    regValue(uninstallKey, "UninstallString"),
  );
  check(
    `Uninstall DisplayVersion ${VERSION_A}`,
    regValue(uninstallKey, "DisplayVersion") === VERSION_A,
    regValue(uninstallKey, "DisplayVersion"),
  );
  check(
    "first install does not enable autostart",
    regValue(`${sandbox.registry}\\Run`, AUMID) === null,
  );

  process.stdout.write(`[${currentScenario}] launcher routing\n`);
  const doctor = runLauncher(sandbox, ["--doctor"]);
  check(
    "launcher --doctor exits 0 and reports this version",
    // 3.x: `atm.exe --doctor` prints `service: {json}` (the running service's own report).
    doctor.status === 0 &&
      doctor.stdout.includes('"ok":true') &&
      doctor.stdout.includes(`"version":"${VERSION_A}"`),
    { status: doctor.status, out: doctor.stdout.slice(0, 200), err: doctor.stderr.slice(0, 200) },
  );
  const hostsBefore = processes(sandbox.install).filter((proc) =>
    proc.path.endsWith("AyanamiTaskManager.exe"),
  ).length;
  const gui = runLauncher(sandbox, ["--background"]);
  check("launcher GUI start returns at once", gui.status === 0, {
    status: gui.status,
    err: gui.stderr,
  });
  await sleep(1500);
  const hostsAfter = processes(sandbox.install).filter((proc) =>
    proc.path.endsWith("AyanamiTaskManager.exe"),
  ).length;
  check(
    "second start hands over to the running host (no second service)",
    hostsAfter === hostsBefore,
    { hostsBefore, hostsAfter },
  );
  check(
    "launcher rejects unknown arguments with 2",
    runLauncher(sandbox, ["--inspect"]).status === 2,
  );

  process.stdout.write(`[${currentScenario}] update ${VERSION_A} → ${VERSION_B}\n`);
  started = Date.now();
  check(
    "update exit 0",
    runSetup(sandbox, join(sandbox.install, "atm-setup.exe"), [
      "install",
      pkg.b.manifest,
      "--quiet",
    ]) === 0,
    sandbox.log(),
  );
  check(
    `update took ${((Date.now() - started) / 1000).toFixed(1)}s (< 30s)`,
    Date.now() - started < 30_000,
  );
  await installed(sandbox, VERSION_B, VERSION_A);
  check(`app-${VERSION_A} kept as previous`, existsSync(join(sandbox.install, `app-${VERSION_A}`)));
  check(
    `no process left from app-${VERSION_A}`,
    processes(join(sandbox.install, `app-${VERSION_A}`)).length === 0,
    processes(join(sandbox.install, `app-${VERSION_A}`)),
  );
  check(
    "root launcher is the new version's",
    readFileSync(join(sandbox.install, "AyanamiTaskManager.exe")).equals(
      readFileSync(join(sandbox.install, `app-${VERSION_B}`, "launcher", "AyanamiTaskManager.exe")),
    ),
  );
  check(
    "same version again is an idempotent success",
    runSetup(sandbox, join(sandbox.install, "atm-setup.exe"), [
      "install",
      pkg.b.manifest,
      "--quiet",
    ]) === 0,
    sandbox.log(2),
  );
  check(
    "…and changes nothing",
    sandbox.pointer()?.current === VERSION_B && sandbox.serviceVersion() === VERSION_B,
  );

  process.stdout.write(`[${currentScenario}] rollback → ${VERSION_A}\n`);
  const rolledBack = spawnSync(join(sandbox.install, "atm-setup.exe"), ["--rollback", "--quiet"], {
    env: sandbox.env(),
    encoding: "utf8",
    windowsHide: true,
    timeout: 240_000,
  });
  check(`rollback exit 0 (${rolledBack.status})`, rolledBack.status === 0, {
    out: `${rolledBack.stdout}${rolledBack.stderr}`.slice(-600),
    log: sandbox.log(3),
  });
  await installed(sandbox, VERSION_A, VERSION_B);

  process.stdout.write(`[${currentScenario}] uninstall\n`);
  runSetup(sandbox, join(sandbox.install, "atm-setup.exe"), ["--uninstall", "--quiet"]);
  check(
    "install root removed",
    await until(() => !existsSync(sandbox.install), 60_000),
    existsSync(sandbox.install) ? readdirSync(sandbox.install) : null,
  );
  check("no process left", processes(sandbox.dir).length === 0, processes(sandbox.dir));
  check("Uninstall key removed", regValue(uninstallKey, "DisplayName") === null);
  check(
    "shortcuts removed",
    !existsSync(startMenu) && !existsSync(join(sandbox.dir, "desktop", "AyanamiTaskManager.lnk")),
  );
  check("current junction removed", junctionTarget(join(sandbox.data, "current")) === null);
  // 3.x keeps its data in N; uninstall removes the program, never the data.
  check("user data kept (N)", existsSync(join(sandbox.v3, "data", "atm.sqlite")));
  teardown(sandbox);
}

type UpdateStatusFile = { code: string; version: string | null; outcome: string };

function updateStatus(sandbox: Sandbox): UpdateStatusFile | null {
  try {
    return JSON.parse(
      readFileSync(join(sandbox.v3, "logs", "update-status.json"), "utf8"),
    ) as UpdateStatusFile;
  } catch {
    return null;
  }
}

/**
 * The update bridge: a package delivered to `N\updates` is found by the service's update
 * coordinator, then installed by exactly the command the host runs for "立即更新"
 * (`atm-setup --update <manifest> --quiet --show`). The coordinator and the host's path
 * checks are covered by the `atm-jobs` update tests and host update.rs tests.
 */
async function scenarioUpdate(pkg: Packages): Promise<void> {
  currentScenario = "update";
  const sandbox = new Sandbox("update");
  reset(sandbox);
  process.stdout.write(`\n[${currentScenario}] install ${VERSION_A}, deliver ${VERSION_B}\n`);
  check(
    "install exit 0",
    runSetup(sandbox, pkg.a.setup, ["install", pkg.a.manifest, "--quiet"]) === 0,
    sandbox.log(),
  );
  killAll(sandbox.dir);
  const feed = join(sandbox.v3, "updates");
  mkdirSync(feed, { recursive: true });
  // Delivery order: the zip first, the manifest last. Plus leftovers of the Squirrel era.
  copyFileSync(
    join(drillRoot, `package-${VERSION_B}`, `atm-${VERSION_B}-win-x64.zip`),
    join(feed, `atm-${VERSION_B}-win-x64.zip`),
  );
  copyFileSync(pkg.b.manifest, join(feed, `atm-${VERSION_B}-win-x64.json`));
  writeFileSync(join(feed, "RELEASES"), "drill");
  writeFileSync(join(feed, "AyanamiTaskManager-1.0.0-full.nupkg"), "drill");
  check("launcher start exits 0", runLauncher(sandbox, ["--background"]).status === 0);
  check(
    `the service reports ${VERSION_B} ready`,
    await until(() => updateStatus(sandbox)?.code === "UPDATE_READY", 30_000),
    updateStatus(sandbox),
  );
  // The ready version reaches the tray, and the toast is handed to Windows (the host logs
  // both; a toast that Windows refused logs "toast failed").
  const hostLog = () => {
    try {
      return readFileSync(join(sandbox.v3, "logs", "host.log"), "utf8");
    } catch {
      return "";
    }
  };
  check(
    `tray offers ${VERSION_B}`,
    await until(() => hostLog().includes(`tray offers update ${VERSION_B}`), 15_000),
    hostLog().slice(-800),
  );
  check(
    "update-ready toast shown",
    await until(() => hostLog().includes("toast shown"), 15_000),
    hostLog().slice(-800),
  );
  check("Squirrel feed leftovers pruned", !existsSync(join(feed, "RELEASES")), readdirSync(feed));
  check(
    "the delivered package is kept until installed",
    existsSync(join(feed, `atm-${VERSION_B}-win-x64.zip`)),
  );

  process.stdout.write(`[${currentScenario}] 立即更新 → ${VERSION_B}\n`);
  // What UpdateCoordinator.apply() records before asking the host.
  writeFileSync(
    join(sandbox.v3, "logs", "update-status.json"),
    JSON.stringify({
      ...updateStatus(sandbox),
      phase: "INSTALL",
      outcome: "IN_PROGRESS",
      code: "INSTALLING",
    }),
  );
  check(
    "atm-setup --update --quiet --show exit 0",
    runSetup(sandbox, join(sandbox.install, "atm-setup.exe"), [
      "--update",
      join(feed, `atm-${VERSION_B}-win-x64.json`),
      "--quiet",
      "--show",
    ]) === 0,
    sandbox.log(),
  );
  await installed(sandbox, VERSION_B, VERSION_A);
  check(
    "new version reports UPDATE_INSTALLED",
    await until(() => updateStatus(sandbox)?.code === "UPDATE_INSTALLED", 30_000),
    updateStatus(sandbox),
  );
  check(
    "consumed package removed from the feed",
    readdirSync(feed).length === 0,
    readdirSync(feed),
  );
  const host = processes(join(sandbox.install, `app-${VERSION_B}`)).find((proc) =>
    proc.path.endsWith("AyanamiTaskManager.exe"),
  );
  const window = host
    ? spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${host.pid}).MainWindowHandle`,
        ],
        { encoding: "utf8", windowsHide: true },
      ).stdout.trim()
    : "";
  check("--show: the new version opened its window", window !== "" && window !== "0", {
    host,
    window,
  });
  teardown(sandbox);
}

function hostsUnder(dir: string): Array<{ pid: number; path: string }> {
  return processes(dir).filter((proc) =>
    proc.path.toLowerCase().endsWith("ayanamitaskmanager.exe"),
  );
}

/**
 * The defects of the Codex review (output/peer0519-tmp/review-install.md), each driven
 * through the real binaries: first-install failure (P2-2), a failed undo finished by
 * "ATM 修复" (P1-3), a ROLLBACK_START replay after the host was spawned (P1-7), and a data
 * root inside the install root (P1-6).
 */
async function scenarioReview(pkg: Packages): Promise<void> {
  currentScenario = "review";
  let sandbox = new Sandbox("review-first");
  reset(sandbox);
  process.stdout.write(`\n[${currentScenario}] first install fails at START (P2-2)\n`);
  runSetup(sandbox, pkg.a.setup, ["install", pkg.a.manifest, "--quiet"], {
    ATM_SETUP_FAIL_AT: "START",
  });
  check(
    "first install failing after SWITCH is ABORTED, not ROLLED_BACK",
    sandbox.journal()?.outcome === "ABORTED",
    { journal: sandbox.journal(), log: sandbox.log(5) },
  );
  check(
    "nothing left installed",
    sandbox.pointer() === null && !existsSync(join(sandbox.install, `app-${VERSION_A}`)),
  );
  teardown(sandbox);

  sandbox = new Sandbox("review-repair");
  reset(sandbox);
  process.stdout.write(`[${currentScenario}] a failed undo, finished by ATM 修复 (P1-3)\n`);
  check(
    "base install",
    runSetup(sandbox, pkg.a.setup, ["install", pkg.a.manifest, "--quiet"]) === 0,
  );
  const failed = runSetup(
    sandbox,
    join(sandbox.install, "atm-setup.exe"),
    ["install", pkg.b.manifest, "--quiet", "--retry"],
    { ATM_SETUP_FAIL_AT: "START", ATM_SETUP_FAIL_UNDO: "2" },
  );
  const stuck = sandbox.journal() as (Journal & { undo?: { step: number } }) | null;
  check(
    "undo step 2 failing ends RECOVERY_FAILED (exit 3), state and step kept",
    failed === 3 &&
      stuck?.outcome === "RECOVERY_FAILED" &&
      stuck.state === "UNDO" &&
      stuck.undo?.step === 2,
    { failed, stuck },
  );
  check(
    "every start is refused until a repair (headless route: no message box)",
    runLauncher(sandbox, ["--doctor"]).status === 3,
  );
  check(
    "a new install is refused too",
    runSetup(sandbox, join(sandbox.install, "atm-setup.exe"), [
      "install",
      pkg.b.manifest,
      "--quiet",
      "--retry",
    ]) !== 0 && sandbox.journal()?.outcome === "RECOVERY_FAILED",
  );
  check(
    "ATM 修复 exit 0",
    runSetup(sandbox, join(sandbox.install, "atm-setup.exe"), ["--repair", "--quiet"]) === 0,
    sandbox.log(8),
  );
  check(
    "the repair resumed the undo: ROLLED_BACK, not a fresh COMMITTED record",
    sandbox.journal()?.outcome === "ROLLED_BACK" && sandbox.journal()?.state === "DONE",
    sandbox.journal(),
  );
  check(
    `${VERSION_A} serving again`,
    sandbox.pointer()?.current === VERSION_A &&
      (await until(() => sandbox.serviceVersion() === VERSION_A, 30_000)),
    { pointer: sandbox.pointer(), service: sandbox.serviceVersion() },
  );
  check(`staged app-${VERSION_B} removed`, !existsSync(join(sandbox.install, `app-${VERSION_B}`)));
  // Undoing a 3.x → 3.x update stays on 3.x: N is still the source (07 §8 settles N only when
  // leaving for an older line).
  check(
    "a 3.x → 3.x undo leaves A=v3 (no setup-rollback)",
    authorityOf(sandbox)?.authority === "v3",
    authorityOf(sandbox),
  );

  process.stdout.write(
    `[${currentScenario}] killed after ROLLBACK_START spawned the host (P1-7)\n`,
  );
  const died = runSetup(
    sandbox,
    join(sandbox.install, "atm-setup.exe"),
    ["install", pkg.b.manifest, "--quiet", "--retry"],
    { ATM_SETUP_FAIL_AT: "START", ATM_SETUP_DIE_AFTER: "SPAWNED:ROLLBACK_START" },
  );
  check("setup died right after spawning (99)", died === 99, sandbox.log(4));
  // The orphaned host finds the journal unfinished and starts its own --recover; this one
  // races it for the install lock. Either may win — what matters is how the journal ends.
  const recovered = runSetup(sandbox, join(sandbox.install, "atm-setup.exe"), [
    "--recover",
    "--quiet",
  ]);
  check(
    "recovered to ROLLED_BACK (by this --recover or the host's own)",
    (recovered === 4 || sandbox.log(12).includes("INSTALL_LOCK_BUSY")) &&
      (await until(() => sandbox.journal()?.outcome === "ROLLED_BACK", 90_000)),
    { recovered, journal: sandbox.journal(), log: sandbox.log(8) },
  );
  check(
    "the recovery took the spawned host over instead of starting a second",
    sandbox.log(12).includes("taking over host"),
    sandbox.log(12),
  );
  check(
    `exactly one ${VERSION_A} host, serving`,
    hostsUnder(join(sandbox.install, `app-${VERSION_A}`)).length === 1 &&
      (await until(() => sandbox.serviceVersion() === VERSION_A, 30_000)),
    hostsUnder(sandbox.install),
  );
  teardown(sandbox);

  sandbox = new Sandbox("review-overlap");
  reset(sandbox);
  process.stdout.write(`[${currentScenario}] data root inside the install root (P1-6)\n`);
  const inside = join(sandbox.install, "data");
  const refused = spawnSync(pkg.a.setup, ["install", pkg.a.manifest, "--quiet"], {
    env: { ...sandbox.env(), ATM_DATA_DIR: inside },
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  check(
    "refused before anything is written",
    refused.status === 1 &&
      refused.stderr.includes("DATA_DIR_OVERLAPS_INSTALL_ROOT") &&
      !existsSync(join(sandbox.install, "app.json")),
    { status: refused.status, err: refused.stderr.slice(0, 200) },
  );
  teardown(sandbox);
}

/**
 * A host that holds the single-instance lock but no lease yet (autostart waiting out
 * `--random-startup-delay`) when an update begins (Codex P1-1). The delay is 0–5 s at
 * random, so rounds repeat until one has setup meet the host while it is still leaseless.
 */
async function scenarioDelayed(pkg: Packages): Promise<void> {
  currentScenario = "delayed";
  const sandbox = new Sandbox("delayed");
  reset(sandbox);
  process.stdout.write(`\n[${currentScenario}] update while a delayed host has no lease yet\n`);
  check(
    "install exit 0",
    runSetup(sandbox, pkg.a.setup, ["install", pkg.a.manifest, "--quiet"]) === 0,
  );
  let exercised = false;
  for (let round = 1; round <= 6 && !exercised; round += 1) {
    killAll(sandbox.dir);
    rmSync(join(sandbox.v3, "runtime", "host.json"), { force: true });
    if (sandbox.pointer()?.current !== VERSION_A)
      runSetup(sandbox, join(sandbox.install, "atm-setup.exe"), ["--rollback", "--quiet"]);
    killAll(sandbox.dir);
    // Killed lease holders leave their lease file behind; with it gone, the file's presence
    // alone says a core has come up. serviceVersion() enumerates processes, which takes
    // seconds — longer than the window this scenario is after.
    const lease = join(sandbox.v3, "runtime", "daemon.json");
    rmSync(lease, { force: true });
    spawn(
      join(sandbox.install, "AyanamiTaskManager.exe"),
      ["--background", "--random-startup-delay"],
      {
        env: sandbox.env(),
        stdio: "ignore",
        windowsHide: true,
        detached: true,
      },
    ).unref();
    await until(() => existsSync(join(sandbox.v3, "runtime", "host.json")), 10_000);
    if (existsSync(lease)) continue;
    const before = sandbox.log(400).split("\n").length;
    const code = runSetup(sandbox, join(sandbox.install, "atm-setup.exe"), [
      "install",
      pkg.b.manifest,
      "--quiet",
      "--retry",
    ]);
    const lines = sandbox
      .log(400)
      .split("\n")
      .slice(before - 1);
    // The leaseless case: QUIESCE found exactly one target, the recorded host.
    exercised = lines.some((line) => /quiesce: QUIT delivered=true targets=\[\d+\]$/u.test(line));
    check(`round ${round}: update exit 0`, code === 0, lines.slice(-6));
    check(
      `round ${round}: ${VERSION_B} serving, no ${VERSION_A} host left`,
      (await until(() => sandbox.serviceVersion() === VERSION_B, 30_000)) &&
        hostsUnder(join(sandbox.install, `app-${VERSION_A}`)).length === 0,
      { service: sandbox.serviceVersion(), hosts: hostsUnder(sandbox.install) },
    );
  }
  check("a round met the host while it had no lease", exercised);
  teardown(sandbox);
}

/**
 * Setup run inside a kill-on-close job (an Agent's terminal; an update started by a host the
 * Agent woke). The ATM it starts must leave the job when the job allows it, or it ends the
 * moment the job's owner does. A job that forbids breakaway still gets a committed install.
 */
async function scenarioJob(pkg: Packages): Promise<void> {
  currentScenario = "job";
  const sandbox = new Sandbox("job");
  reset(sandbox);
  process.stdout.write(`\n[${currentScenario}] install from inside a kill-on-close job\n`);
  const inJob = (extra: string[], args: string[]) =>
    spawnSync(jobRunner, [...extra, "--", pkg.a.setup, ...args], {
      env: sandbox.env(),
      encoding: "utf8",
      windowsHide: true,
      timeout: 180_000,
    }).status;
  check(
    "install exit 0 (job allows breakaway)",
    inJob([], ["install", pkg.a.manifest, "--quiet"]) === 0,
  );
  // job-runner has exited: its job is closed and everything left inside it is gone.
  await sleep(3_000);
  check(
    "the started ATM outlived the job",
    hostsUnder(join(sandbox.install, `app-${VERSION_A}`)).length === 1 &&
      (await until(() => sandbox.serviceVersion() === VERSION_A, 10_000)),
    hostsUnder(sandbox.install),
  );
  killAll(sandbox.dir);
  runSetup(sandbox, join(sandbox.install, "atm-setup.exe"), ["--uninstall", "--quiet"]);
  await until(() => !existsSync(join(sandbox.install, "app.json")), 60_000);

  reset(sandbox);
  check(
    "install still commits when the job forbids breakaway",
    inJob(["--no-breakaway"], ["install", pkg.a.manifest, "--quiet"]) === 0 &&
      sandbox.journal()?.outcome === "COMMITTED",
    sandbox.log(6),
  );
  teardown(sandbox);
}

/** An uninstall that meets a file in use stops short, keeps its barrier, and resumes (P1-2). */
async function scenarioUninstallBusy(pkg: Packages): Promise<void> {
  currentScenario = "uninstall-busy";
  const sandbox = new Sandbox("uninstall-busy");
  reset(sandbox);
  process.stdout.write(`\n[${currentScenario}] uninstall with a file held open\n`);
  check(
    "install exit 0",
    runSetup(sandbox, pkg.a.setup, ["install", pkg.a.manifest, "--quiet"]) === 0,
  );
  const busy = join(sandbox.install, `app-${VERSION_A}`, "renderer", "index.html");
  const holder = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$f = [IO.File]::Open('${busy.replaceAll("'", "''")}', 'Open', 'Read', 'None'); Start-Sleep -Seconds 120; $f.Close()`,
    ],
    { stdio: "ignore", windowsHide: true },
  );
  await sleep(1500);
  runSetup(sandbox, join(sandbox.install, "atm-setup.exe"), ["--uninstall", "--quiet"]);
  // The root copy re-runs itself from a temporary copy and returns at once.
  await until(() => !installLockHeld(sandbox) && sandbox.journal()?.kind === "UNINSTALL", 60_000);
  await until(() => !installLockHeld(sandbox), 60_000);
  const journal = sandbox.journal();
  check(
    "stopped short: journal still UNINSTALL (the barrier holds)",
    journal?.kind === "UNINSTALL" && journal.state === "UNINSTALL" && journal.outcome == null,
    journal,
  );
  check("the version pointer went first", sandbox.pointer() === null);
  check("the file in use is still there", existsSync(busy));
  check(
    "the Apps-list entry stays, so the uninstall can be run again",
    regValue(`${sandbox.registry}\\Uninstall\\AyanamiTaskManagerDesktop`, "UninstallString") !==
      null,
  );
  check("atm-setup.exe kept for that", existsSync(join(sandbox.install, "atm-setup.exe")));
  holder.kill();
  await sleep(1000);
  runSetup(sandbox, join(sandbox.install, "atm-setup.exe"), ["--uninstall", "--quiet"]);
  check(
    "run again: the install root is gone",
    await until(() => !existsSync(sandbox.install), 60_000),
    existsSync(sandbox.install) ? readdirSync(sandbox.install) : null,
  );
  check(
    "and the Apps-list entry with it",
    regValue(`${sandbox.registry}\\Uninstall\\AyanamiTaskManagerDesktop`, "UninstallString") ===
      null,
  );
  // 3.x keeps its data in N; uninstall removes the program, never the data.
  check("user data kept (N)", existsSync(join(sandbox.v3, "data", "atm.sqlite")));
  teardown(sandbox);
}

function installLockHeld(sandbox: Sandbox): boolean {
  const lock = join(sandbox.install, "state", "install.lock");
  if (!existsSync(lock)) return false;
  try {
    const fd = openSync(lock, "r+");
    closeSync(fd);
    return false;
  } catch {
    return true;
  }
}

/** Setup dies right after persisting each state; the next start (the launcher) recovers. */
async function scenarioFaults(pkg: Packages): Promise<void> {
  currentScenario = "faults";
  const sandbox = new Sandbox("faults");
  reset(sandbox);
  process.stdout.write(`\n[${currentScenario}] base install ${VERSION_A}\n`);
  check(
    "base install",
    runSetup(sandbox, pkg.a.setup, ["install", pkg.a.manifest, "--quiet"]) === 0,
    sandbox.log(),
  );
  const expected: Array<[string, "ABORTED" | "ROLLED_BACK" | "COMMITTED"]> = [
    ["STAGE", "ABORTED"],
    ["PROBE", "ABORTED"],
    ["SNAPSHOT", "ABORTED"],
    ["FENCE", "ABORTED"],
    ["QUIESCE", "ABORTED"],
    ["SEAL", "ABORTED"],
    ["SWITCH", "ROLLED_BACK"],
    ["START", "ROLLED_BACK"],
    ["UNDO:2", "ROLLED_BACK"],
    ["COMMIT", "COMMITTED"],
  ];
  for (const [state, outcome] of expected) {
    process.stdout.write(`[${currentScenario}] die after ${state}\n`);
    // UNDO:2 = die in the middle of the undo that a failed START started.
    const extra: Record<string, string> =
      state === "UNDO:2"
        ? { ATM_SETUP_FAIL_AT: "START", ATM_SETUP_DIE_AFTER: "UNDO:2" }
        : { ATM_SETUP_DIE_AFTER: state };
    const code = runSetup(
      sandbox,
      join(sandbox.install, "atm-setup.exe"),
      ["install", pkg.b.manifest, "--quiet", "--retry"],
      extra,
    );
    check(`${state}: setup died (99)`, code === 99, { code, log: sandbox.log(4) });
    check(
      `${state}: journal left unfinished`,
      sandbox.journal()?.outcome == null,
      sandbox.journal(),
    );
    // The next ordinary start is what recovers: the launcher's barrier runs --recover.
    // Output captured through pipes: the host the recovery starts must not inherit them,
    // or this call waits until that host exits (it did, ~240 s per round, before the fix).
    const begun = Date.now();
    const start = runLauncher(sandbox, ["--background"]);
    check(
      `${state}: launcher start exits 0 within 20s (${((Date.now() - begun) / 1000).toFixed(1)}s)`,
      start.status === 0 && Date.now() - begun < 20_000,
      { status: start.status, err: start.stderr.slice(0, 200) },
    );
    const journal = sandbox.journal();
    check(
      `${state}: recovered to ${outcome}`,
      journal?.state === "DONE" && journal.outcome === outcome,
      { journal, log: sandbox.log(6) },
    );
    const version = outcome === "COMMITTED" ? VERSION_B : VERSION_A;
    check(
      `${state}: app.json.current = ${version}`,
      sandbox.pointer()?.current === version,
      sandbox.pointer(),
    );
    check(
      `${state}: service running ${version}`,
      await until(() => sandbox.serviceVersion() === version, 30_000),
      sandbox.serviceVersion(),
    );
    if (outcome !== "COMMITTED") {
      check(
        `${state}: staged app-${VERSION_B} removed`,
        !existsSync(join(sandbox.install, `app-${VERSION_B}`)),
      );
      check(
        `${state}: root launcher is ${VERSION_A}'s again`,
        readFileSync(join(sandbox.install, "AyanamiTaskManager.exe")).equals(
          readFileSync(
            join(sandbox.install, `app-${VERSION_A}`, "launcher", "AyanamiTaskManager.exe"),
          ),
        ),
      );
    }
  }
  process.stdout.write(`[${currentScenario}] in-process failures\n`);
  runSetup(sandbox, join(sandbox.install, "atm-setup.exe"), ["--rollback", "--quiet"]);
  for (const [state, outcome] of [
    ["PROBE", "ABORTED"],
    ["SEAL", "ABORTED"],
    ["START", "ROLLED_BACK"],
  ] as const) {
    const code = runSetup(
      sandbox,
      join(sandbox.install, "atm-setup.exe"),
      ["install", pkg.b.manifest, "--quiet", "--retry"],
      { ATM_SETUP_FAIL_AT: state },
    );
    const journal = sandbox.journal();
    check(`fail at ${state} → ${outcome} (exit ${code})`, journal?.outcome === outcome, {
      journal,
      log: sandbox.log(5),
    });
    check(
      `fail at ${state}: still serving ${VERSION_A}`,
      await until(() => sandbox.serviceVersion() === VERSION_A, 30_000),
      sandbox.serviceVersion(),
    );
  }
  const refused = runSetup(sandbox, join(sandbox.install, "atm-setup.exe"), [
    "install",
    pkg.b.manifest,
    "--quiet",
  ]);
  check(
    "a version that failed twice is not retried without --retry",
    refused !== 0 && sandbox.pointer()?.current === VERSION_A,
    { refused, log: sandbox.log(2) },
  );
  teardown(sandbox);
}

/** A Squirrel 1.x layout with its registrations, served by the fake Electron. */
async function squirrelLayout(sandbox: Sandbox): Promise<void> {
  const app = join(sandbox.install, `app-${LEGACY}`);
  mkdirSync(join(app, "resources"), { recursive: true });
  copyFileSync(fakeElectron, join(app, "AyanamiTaskManager.exe"));
  writeFileSync(join(app, "resources", "app.asar"), "drill");
  copyFileSync(fakeElectron, join(sandbox.install, "AyanamiTaskManager.exe"));
  copyFileSync(fakeElectron, join(sandbox.install, "Update.exe"));
  mkdirSync(join(sandbox.install, "packages"), { recursive: true });
  writeFileSync(join(sandbox.install, "packages", "RELEASES"), "drill");
  writeFileSync(join(sandbox.install, "app.ico"), "drill");
  const key = `${sandbox.registry}\\Uninstall\\AyanamiTaskManagerDesktop`;
  const update = `"${join(sandbox.install, "Update.exe")}"`;
  for (const [name, value] of <Array<[string, string]>>[
    ["DisplayName", "AyanamiTaskManager"],
    ["DisplayVersion", LEGACY],
    ["InstallLocation", sandbox.install],
    ["UninstallString", `${update} --uninstall`],
    ["QuietUninstallString", `${update} --uninstall -s`],
    ["InstallDate", "20260930"],
  ])
    reg(["add", key, "/v", name, "/t", "REG_SZ", "/d", value, "/f"]);
  reg([
    "add",
    `${sandbox.registry}\\Run`,
    "/v",
    AUMID,
    "/t",
    "REG_SZ",
    "/d",
    `"${join(sandbox.data, "current", "AyanamiTaskManager.exe")}" --background --random-startup-delay`,
    "/f",
  ]);
  for (const dir of [join(sandbox.dir, "start-menu", "ayanami"), join(sandbox.dir, "desktop")]) {
    mkdirSync(dir, { recursive: true });
    const lnk = join(dir, "AyanamiTaskManager.lnk").replaceAll("'", "''");
    const target = join(sandbox.install, "AyanamiTaskManager.exe").replaceAll("'", "''");
    spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${lnk}'); $s.TargetPath = '${target}'; $s.WorkingDirectory = '${app.replaceAll("'", "''")}'; $s.Save()`,
      ],
      { windowsHide: true },
    );
  }
  spawn(join(app, "AyanamiTaskManager.exe"), ["--background"], {
    env: sandbox.env(),
    stdio: "ignore",
    windowsHide: true,
    detached: true,
  }).unref();
  await until(() => existsSync(join(sandbox.data, "runtime", "daemon.json")), 15_000);
}

async function scenarioMigration(pkg: Packages): Promise<void> {
  currentScenario = "migration";
  const sandbox = new Sandbox("migration");
  reset(sandbox);
  process.stdout.write(
    `\n[${currentScenario}] Squirrel ${LEGACY} layout with a running (fake) Electron\n`,
  );
  await squirrelLayout(sandbox);
  const stub = readFileSync(join(sandbox.install, "AyanamiTaskManager.exe"));
  check(
    `fake Electron serves ${LEGACY}`,
    await until(() => sandbox.serviceVersion() === LEGACY),
    sandbox.serviceVersion(),
  );
  check(
    "old app points current at its own app dir",
    samePath(junctionTarget(join(sandbox.data, "current")), join(sandbox.install, `app-${LEGACY}`)),
    junctionTarget(join(sandbox.data, "current")),
  );
  check(
    "without --force a running Electron blocks migration (quiet = no prompt)",
    runSetup(sandbox, pkg.a.setup, ["install", pkg.a.manifest, "--quiet"]) !== 0,
    sandbox.log(4),
  );
  check(
    "…ABORTED, Electron untouched",
    sandbox.journal()?.outcome === "ABORTED" &&
      sandbox.serviceVersion() === LEGACY &&
      existsSync(join(sandbox.install, `app-${LEGACY}`)),
    { journal: sandbox.journal(), log: sandbox.log(4) },
  );

  process.stdout.write(
    `[${currentScenario}] migrate → ${VERSION_A} (--force); Squirrel adds ${SQUIRREL_ADDED} after the snapshot\n`,
  );
  check(
    "migration exit 0",
    runSetup(sandbox, pkg.a.setup, ["install", pkg.a.manifest, "--quiet", "--force", "--retry"], {
      ATM_SETUP_SQUIRREL_ADDS: SQUIRREL_ADDED,
    }) === 0,
    sandbox.log(),
  );
  await installed(sandbox, VERSION_A, `legacy:${LEGACY}`);
  const rollback = join(sandbox.install, "state", "rollback");
  const migrationItems = (
    JSON.parse(readFileSync(join(rollback, "migration.json"), "utf8")) as {
      legacy: { items: string[] };
    }
  ).legacy.items;
  check(
    `${SQUIRREL_ADDED} (appeared after the snapshot) recorded for a reverse migration`,
    migrationItems.includes(SQUIRREL_ADDED),
    migrationItems,
  );
  for (const item of [`app-${LEGACY}`, SQUIRREL_ADDED, "Update.exe", "packages"])
    check(
      `${item} isolated in state\\rollback\\legacy`,
      existsSync(join(rollback, "legacy", item)) && !existsSync(join(sandbox.install, item)),
    );
  check(
    "Squirrel stub saved for a reverse migration",
    readFileSync(join(rollback, "legacy-stub", "AyanamiTaskManager.exe")).equals(stub),
  );
  check("migration.json written", existsSync(join(rollback, "migration.json")));
  check(
    "no fake Electron left",
    processes(join(sandbox.install, "state")).length === 0 &&
      processes(join(sandbox.install, `app-${LEGACY}`)).length === 0,
  );
  const run = regValue(`${sandbox.registry}\\Run`, AUMID);
  check(
    "Run value kept, now straight at the root launcher, arguments kept",
    run ===
      `"${join(sandbox.install, "AyanamiTaskManager.exe")}" --background --random-startup-delay`,
    run,
  );
  const key = `${sandbox.registry}\\Uninstall\\AyanamiTaskManagerDesktop`;
  check(
    "Uninstall key rewritten for atm-setup, InstallDate kept",
    (regValue(key, "UninstallString") ?? "").includes("atm-setup.exe") &&
      regValue(key, "InstallDate") === "20260930",
    { u: regValue(key, "UninstallString"), d: regValue(key, "InstallDate") },
  );
  const desktop = shortcut(join(sandbox.dir, "desktop", "AyanamiTaskManager.lnk"));
  check(
    `existing desktop shortcut rewritten: workdir no longer app-${LEGACY}`,
    samePath(desktop?.workdir ?? null, sandbox.install),
    desktop,
  );
  check(
    "user data still readable by the new core (same registry DB)",
    existsSync(join(sandbox.data, "registry", "registry.sqlite")),
  );

  process.stdout.write(`[${currentScenario}] back to Electron\n`);
  check(
    "reverse migration exit 0",
    runSetup(sandbox, join(sandbox.install, "atm-setup.exe"), ["--rollback", "--quiet"]) === 0,
    sandbox.log(),
  );
  check(
    "app.json = legacy pointer",
    sandbox.pointer()?.current === `legacy:${LEGACY}` && sandbox.pointer()?.previous === VERSION_A,
    sandbox.pointer(),
  );
  check(
    "Electron serving again",
    await until(() => sandbox.serviceVersion() === LEGACY, 20_000),
    sandbox.serviceVersion(),
  );
  check(
    "stub back at the root",
    readFileSync(join(sandbox.install, "AyanamiTaskManager.exe")).equals(stub),
  );
  check(
    `app-${LEGACY}, ${SQUIRREL_ADDED}, Update.exe, packages back in place`,
    [`app-${LEGACY}`, SQUIRREL_ADDED, "Update.exe", "packages"].every((item) =>
      existsSync(join(sandbox.install, item)),
    ),
  );
  check(
    "new-style versions moved out of the stub's reach",
    !existsSync(join(sandbox.install, `app-${VERSION_A}`)) &&
      existsSync(join(rollback, "newstyle", `app-${VERSION_A}`)),
  );
  check(
    "Squirrel Uninstall string restored",
    (regValue(key, "UninstallString") ?? "").includes("Update.exe"),
  );
  check(
    "Run value restored to the current\\ form",
    (regValue(`${sandbox.registry}\\Run`, AUMID) ?? "").includes(
      `${join(sandbox.data, "current")}`,
    ),
  );
  check(
    "no new-style process left",
    processes(join(sandbox.install, "state", "rollback", "newstyle")).length === 0,
  );

  process.stdout.write(`[${currentScenario}] migrate again, then die after ISOLATE and recover\n`);
  const code = runSetup(
    sandbox,
    pkg.a.setup,
    ["install", pkg.a.manifest, "--quiet", "--force", "--retry"],
    { ATM_SETUP_DIE_AFTER: "ISOLATE" },
  );
  check("died after ISOLATE (99)", code === 99, sandbox.log(3));
  check(
    "recover exit (ABORTED = 1)",
    runSetup(sandbox, pkg.a.setup, ["--recover", "--quiet"]) === 1,
    sandbox.log(4),
  );
  check(
    "Electron restored and serving",
    await until(() => sandbox.serviceVersion() === LEGACY, 20_000),
    { v: sandbox.serviceVersion(), log: sandbox.log(6) },
  );
  check(
    "stub restored after the aborted migration",
    readFileSync(join(sandbox.install, "AyanamiTaskManager.exe")).equals(stub),
  );
  check(
    "current points at the Electron app again",
    samePath(junctionTarget(join(sandbox.data, "current")), join(sandbox.install, `app-${LEGACY}`)),
    junctionTarget(join(sandbox.data, "current")),
  );

  process.stdout.write(
    `[${currentScenario}] migrate, then a reverse migration that fails at R_START_LEGACY\n`,
  );
  check(
    "migrate again exit 0",
    runSetup(sandbox, pkg.a.setup, ["install", pkg.a.manifest, "--quiet", "--force", "--retry"]) ===
      0,
    sandbox.log(4),
  );
  runSetup(sandbox, join(sandbox.install, "atm-setup.exe"), ["--rollback", "--quiet"], {
    ATM_SETUP_FAIL_AT: "R_START_LEGACY",
  });
  check(
    "UNDO_LEGACY → ABORTED",
    sandbox.journal()?.outcome === "ABORTED" && sandbox.journal()?.kind === "LEGACY",
    { j: sandbox.journal(), log: sandbox.log(6) },
  );
  check(
    `still on ${VERSION_A}, serving`,
    sandbox.pointer()?.current === VERSION_A &&
      (await until(() => sandbox.serviceVersion() === VERSION_A, 20_000)),
    { p: sandbox.pointer(), v: sandbox.serviceVersion() },
  );
  check(
    "Electron assets isolated again",
    existsSync(join(rollback, "legacy", `app-${LEGACY}`)) &&
      !existsSync(join(sandbox.install, `app-${LEGACY}`)),
  );
  teardown(sandbox);
}

/**
 * Codex r2 P1-1: both reverse-migration paths that bring B back through ROLLBACK_START —
 * UNDO_LEGACY step 5 and the R_QUIESCE recovery — killed with the host already started:
 * right after it was spawned and recorded (SPAWNED), once it is the primary instance but
 * before any lease (PRIMARY), and once its core holds the lease but before setup saw the
 * witness (LEASED). The replay must take that host over and wait for its witness, never
 * start a second one, and never take a lease as "B is serving".
 */
async function scenarioReverseReplay(pkg: Packages): Promise<void> {
  currentScenario = "reverse-replay";
  const sandbox = new Sandbox("reverse-replay");
  reset(sandbox);
  process.stdout.write(
    `\n[${currentScenario}] Squirrel ${LEGACY} layout, migrate → ${VERSION_A}\n`,
  );
  await squirrelLayout(sandbox);
  check(
    "migration exit 0",
    runSetup(sandbox, pkg.a.setup, ["install", pkg.a.manifest, "--quiet", "--force"]) === 0,
    sandbox.log(),
  );
  await installed(sandbox, VERSION_A, `legacy:${LEGACY}`);
  const setup = join(sandbox.install, "atm-setup.exe");
  const appA = join(sandbox.install, `app-${VERSION_A}`);

  const replay = async (label: string, point: string, step: number): Promise<void> => {
    const journal = sandbox.journal();
    check(
      `${label}: died at ROLLBACK_START (step ${step}), journal unfinished`,
      journal?.state === "ROLLBACK_START" &&
        journal.kind === "LEGACY" &&
        journal.undo?.step === step &&
        journal.outcome == null,
      journal,
    );
    const died = sandbox.log(6);
    check(
      `${label}: the fault point was really reached`,
      died.includes(`ATM_SETUP_DRILL_DIE ${point}:ROLLBACK_START reached=true`) &&
        (point !== "PRIMARY" || died.includes("primary=true lease=false")) &&
        (point !== "LEASED" || died.includes("lease=true")),
      died,
    );
    const started = journal?.started?.pid ?? -1;
    const mark = sandbox.logMark();
    // SPAWNED: the orphaned host was not admitted with its --txn-start (the lock was free)
    // and runs its own --recover, racing this one for the lock. Either may win.
    const code = runSetup(sandbox, setup, ["--recover", "--quiet"]);
    check(
      `${label}: recovered to ABORTED`,
      (code === 1 || sandbox.since(mark).includes("INSTALL_LOCK_BUSY")) &&
        (await until(() => sandbox.journal()?.outcome === "ABORTED", 90_000)),
      { code, journal: sandbox.journal(), log: sandbox.since(mark).slice(-1500) },
    );
    const log = sandbox.since(mark);
    check(
      `${label}: the replay took over the host started earlier`,
      log.includes(`ROLLBACK_START: taking over host ${started}`),
      log.slice(-1500),
    );
    if (point !== "SPAWNED")
      check(
        `${label}: …and verified its witness instead of starting a second host`,
        log.includes(`SERVICE_HEALTHY (host ${started})`) && !log.includes("never served"),
        log.slice(-1500),
      );
    else
      check(
        `${label}: B confirmed by a witness`,
        /START \S+ SERVICE_HEALTHY \(host \d+\)/u.test(log),
        log.slice(-1500),
      );
    check(
      `${label}: still on ${VERSION_A}`,
      sandbox.pointer()?.current === VERSION_A &&
        sandbox.pointer()?.previous === `legacy:${LEGACY}`,
      sandbox.pointer(),
    );
    check(
      `${label}: exactly one ${VERSION_A} host, serving`,
      (await until(() => sandbox.serviceVersion() === VERSION_A, 30_000)) &&
        (await until(() => hostsUnder(appA).length === 1, 15_000)),
      { service: sandbox.serviceVersion(), hosts: hostsUnder(sandbox.install) },
    );
  };

  for (const point of ["SPAWNED", "PRIMARY", "LEASED"]) {
    const label = `UNDO_LEGACY ${point}`;
    process.stdout.write(`[${currentScenario}] ${label}\n`);
    const code = runSetup(sandbox, setup, ["--rollback", "--quiet"], {
      ATM_SETUP_FAIL_AT: "R_START_LEGACY",
      ATM_SETUP_DIE_AFTER: `${point}:ROLLBACK_START`,
    });
    check(`${label}: setup died (99)`, code === 99, { code, log: sandbox.log(6) });
    await replay(label, point, 5);
  }

  for (const point of ["SPAWNED", "PRIMARY", "LEASED"]) {
    const label = `R_QUIESCE ${point}`;
    process.stdout.write(`[${currentScenario}] ${label}\n`);
    const first = runSetup(sandbox, setup, ["--rollback", "--quiet"], {
      ATM_SETUP_DIE_AFTER: "R_QUIESCE",
    });
    check(
      `${label}: reverse migration died at R_QUIESCE (99)`,
      first === 99 && sandbox.journal()?.state === "R_QUIESCE",
      { first, journal: sandbox.journal() },
    );
    // The recovery of R_QUIESCE restarts B — and dies with that host started.
    const second = runSetup(sandbox, setup, ["--recover", "--quiet"], {
      ATM_SETUP_DIE_AFTER: `${point}:ROLLBACK_START`,
    });
    check(`${label}: its recovery died (99)`, second === 99, { second, log: sandbox.log(6) });
    await replay(label, point, 3);
  }
  teardown(sandbox);
}

/**
 * Codex r2 P2-6: a RECOVERY_FAILED record the first implementation wrote (state DONE, undo
 * progress kept). With its undo progress, ATM 修复 converts it and finishes the undo; without,
 * it refuses and leaves the barrier in place — never a fresh COMMITTED record.
 */
async function scenarioLegacyRecord(pkg: Packages): Promise<void> {
  currentScenario = "legacy-record";
  const sandbox = new Sandbox("legacy-record");
  reset(sandbox);
  const setup = join(sandbox.install, "atm-setup.exe");
  const journalPath = join(sandbox.install, "state", "install.json");
  process.stdout.write(`\n[${currentScenario}] base install, then an undo that fails\n`);
  check(
    "base install",
    runSetup(sandbox, pkg.a.setup, ["install", pkg.a.manifest, "--quiet"]) === 0,
  );
  const failUndo = (): Record<string, unknown> | null => {
    runSetup(sandbox, setup, ["install", pkg.b.manifest, "--quiet", "--retry"], {
      ATM_SETUP_FAIL_AT: "START",
      ATM_SETUP_FAIL_UNDO: "2",
    });
    const journal = sandbox.journal();
    if (journal?.outcome !== "RECOVERY_FAILED" || journal.state !== "UNDO") return null;
    // What the first implementation wrote: the same record, closed as DONE.
    const old = { ...(JSON.parse(readFileSync(journalPath, "utf8")) as object), state: "DONE" };
    writeFileSync(journalPath, `${JSON.stringify(old, null, 2)}\n`);
    return old as Record<string, unknown>;
  };

  process.stdout.write(`[${currentScenario}] an old record with its undo progress\n`);
  const old = failUndo();
  check("old-format RECOVERY_FAILED record in place", old !== null, sandbox.journal());
  check("starts are refused (3)", runLauncher(sandbox, ["--doctor"]).status === 3);
  check("ATM 修复 exit 0", runSetup(sandbox, setup, ["--repair", "--quiet"]) === 0, sandbox.log(8));
  check(
    "the old record was resumed: ROLLED_BACK under its own id, not a fresh COMMITTED",
    sandbox.journal()?.id === old?.id &&
      sandbox.journal()?.outcome === "ROLLED_BACK" &&
      sandbox.journal()?.state === "DONE",
    sandbox.journal(),
  );
  check(
    `${VERSION_A} serving again, app-${VERSION_B} removed`,
    sandbox.pointer()?.current === VERSION_A &&
      (await until(() => sandbox.serviceVersion() === VERSION_A, 30_000)) &&
      !existsSync(join(sandbox.install, `app-${VERSION_B}`)),
    { pointer: sandbox.pointer(), service: sandbox.serviceVersion() },
  );

  process.stdout.write(`[${currentScenario}] an old record that does not say where it failed\n`);
  const bare = failUndo();
  check("old-format record in place", bare !== null, sandbox.journal());
  delete bare?.undo;
  writeFileSync(journalPath, `${JSON.stringify(bare, null, 2)}\n`);
  const before = readFileSync(journalPath);
  const refused = spawnSync(setup, ["--repair", "--quiet"], {
    env: sandbox.env(),
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  });
  check(
    "ATM 修复 refuses with the manual steps",
    refused.status !== 0 && refused.stderr.includes("REPAIR_MANUAL_REQUIRED"),
    { status: refused.status, err: refused.stderr.slice(0, 300) },
  );
  check("the failed record is left exactly as it was", readFileSync(journalPath).equals(before));
  check("starts are still refused (3)", runLauncher(sandbox, ["--doctor"]).status === 3);
  teardown(sandbox);
}

/**
 * Codex r2 P2-3: an uninstall paused right after it released the install lock while a new
 * install runs in that gap. The uninstall's remaining work must not delete the new
 * install's atm-setup.exe or journal.
 */
async function scenarioUninstallRace(pkg: Packages): Promise<void> {
  currentScenario = "uninstall-race";
  const sandbox = new Sandbox("uninstall-race");
  reset(sandbox);
  const pause = join(sandbox.dir, "pause");
  process.stdout.write(`\n[${currentScenario}] install, uninstall paused after its lock\n`);
  check(
    "install exit 0",
    runSetup(sandbox, pkg.a.setup, ["install", pkg.a.manifest, "--quiet"]) === 0,
  );
  // Run from the package (outside the root), so it runs in place with the fault variable.
  const uninstall = spawn(pkg.a.setup, ["--uninstall", "--quiet"], {
    env: sandbox.env({ ATM_SETUP_PAUSE_UNLOCKED: pause }),
    stdio: "ignore",
    windowsHide: true,
  });
  check(
    "the uninstall reached the gap after its lock",
    await until(() => existsSync(join(pause, "paused")), 90_000),
  );
  check(
    "atm-setup.exe and the journal were removed while it held the lock",
    !existsSync(join(sandbox.install, "atm-setup.exe")) &&
      !existsSync(join(sandbox.install, "state", "install.json")),
    existsSync(sandbox.install) ? readdirSync(sandbox.install) : null,
  );
  process.stdout.write(`[${currentScenario}] a new install in the gap\n`);
  check(
    "new install exit 0",
    runSetup(sandbox, pkg.a.setup, ["install", pkg.a.manifest, "--quiet"]) === 0,
    sandbox.log(6),
  );
  const journal = sandbox.journal();
  writeFileSync(join(pause, "resume"), "drill");
  check("the paused uninstall finished", await until(() => uninstall.exitCode !== null, 60_000));
  check(
    "the new install's atm-setup.exe survived",
    existsSync(join(sandbox.install, "atm-setup.exe")),
    existsSync(sandbox.install) ? readdirSync(sandbox.install) : null,
  );
  check(
    "the new install's journal survived",
    journal !== null &&
      sandbox.journal()?.id === journal.id &&
      sandbox.journal()?.outcome === "COMMITTED",
    { before: journal, after: sandbox.journal() },
  );
  check(
    `the new install still works (${VERSION_A})`,
    sandbox.pointer()?.current === VERSION_A && runLauncher(sandbox, ["--doctor"]).status === 0,
    sandbox.pointer(),
  );
  teardown(sandbox);
}

// ---------------------------------------------------------------- 2.0 ⇄ 3.0（W8b）

/**
 * The 2.0 package and its drill setup (sandbox and fault injection), from the 2.0-era drill
 * build: `output/drill/package-2.0.0`. The production 2.0 setup has no sandbox, so it must
 * never be used here.
 */
const PACKAGE_20 = {
  setup: join(drillRoot, "package-2.0.0", "atm-setup.exe"),
  manifest: join(drillRoot, "package-2.0.0", "atm-2.0.0-win-x64.json"),
};
// The version comes from the package itself, not a literal: the release chain treats a literal of
// the current version outside the version sites as a leftover of a version bump.
const V20 = existsSync(PACKAGE_20.manifest)
  ? (JSON.parse(readFileSync(PACKAGE_20.manifest, "utf8")) as { version: string }).version
  : "2.x (package missing)";

type Step = {
  scenario: string;
  step: string;
  current: string | null;
  L: Business | null;
  N: Business | null;
  authority: { authority: string; by: string; generation: string | null } | null;
  generation: string | null;
};
const business: Step[] = [];

function authorityOf(sandbox: Sandbox): Step["authority"] {
  const path = join(sandbox.v3, "authority.json");
  if (!existsSync(path)) return null;
  const a = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return {
    authority: String(a.authority),
    by: String(a.by),
    generation: (a.generation as string | null) ?? null,
  };
}

function generationOf(sandbox: Sandbox): string | null {
  const path = join(sandbox.v3, "conversion.json");
  if (!existsSync(path)) return null;
  const m = JSON.parse(readFileSync(path, "utf8")) as { phase?: string; generation?: string };
  return m.phase === "PUBLISHED" ? (m.generation ?? null) : null;
}

/** Both roots' business content, the authority record and the generation, for the report. */
function summarize(sandbox: Sandbox, step: string): Step {
  const row: Step = {
    scenario: currentScenario,
    step,
    current: sandbox.pointer()?.current ?? null,
    L: legacyBusiness(sandbox.data),
    N: v3Business(sandbox.v3),
    authority: authorityOf(sandbox),
    generation: generationOf(sandbox),
  };
  business.push(row);
  process.stdout.write(
    `    · ${step}: L ${row.L?.records.length ?? "-"} records, N ${row.N?.records.length ?? "-"} records, A ${row.authority ? `${row.authority.authority}/${row.authority.by}` : "-"}, g ${row.generation ?? "-"}\n`,
  );
  return row;
}

/** The 2.0 command line (`runtime\atm-core.exe runtime\cli.mjs`); its service must be up. */
function cli20(sandbox: Sandbox, args: string[]): SpawnSyncReturns<string> {
  const app = join(sandbox.install, `app-${V20}`, "runtime");
  return spawnSync(join(app, "atm-core.exe"), [join(app, "cli.mjs"), "--json", ...args], {
    env: sandbox.env(),
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
}

/** The 3.x command line of `version` (`resources\atm.exe`), through N\runtime\daemon.json. */
function cli3(sandbox: Sandbox, version: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync(
    join(sandbox.install, `app-${version}`, "resources", "atm.exe"),
    ["--json", ...args],
    { env: sandbox.env(), encoding: "utf8", windowsHide: true, timeout: 60_000 },
  );
}

function record(
  run: (args: string[]) => SpawnSyncReturns<string>,
  title: string,
  summary: string,
): boolean {
  const result = run([
    "record",
    "DRL",
    "--kind",
    "DECISION",
    "--title",
    title,
    "--summary",
    summary,
  ]);
  return result.status === 0;
}

const hasRecord = (side: Business | null, title: string) =>
  side?.records.some((row) => row.includes(` ${title} `)) ?? false;

async function install20(sandbox: Sandbox): Promise<boolean> {
  if (!existsSync(PACKAGE_20.setup) || !existsSync(PACKAGE_20.manifest)) {
    check(
      "the 2.0 drill package is in output/drill/package-2.0.0 (see the header)",
      false,
      PACKAGE_20,
    );
    return false;
  }
  const code = runSetup(sandbox, PACKAGE_20.setup, ["install", PACKAGE_20.manifest, "--quiet"]);
  check(`2.0 install exit 0 (${code})`, code === 0, sandbox.log(4));
  check(
    "2.0 serving (two-process, L\\runtime)",
    await until(() => sandbox.serviceVersion() === V20, 30_000),
    sandbox.serviceVersion(),
  );
  const source = join(sandbox.dir, "src");
  mkdirSync(source, { recursive: true });
  const created = cli20(sandbox, [
    "project",
    "create",
    source,
    "--name",
    "演练项目",
    "--code",
    "DRL",
  ]);
  check("2.0 CLI creates project DRL", created.status === 0, created.stderr.slice(0, 300));
  check(
    "2.0 CLI writes DRL-D-001",
    record((args) => cli20(sandbox, args), "升级前写入", "2.0 写的"),
  );
  // 真实用户的 2.0 跑过一阵：新项目当天的自动备份已经做过。2.0 每次启动先做当天还没做的 DAILY / WEEKLY
  // 备份（backup_catalog + global_events 的 backup.created），这些都在回滚检测摘要里（05 §5.2，保守方向）；
  // 不先让它做完，回滚后 2.0 一重启就会写这一笔，「没动过 2.x」就不成立。
  killAll(sandbox.dir);
  check("2.0 restarts", runLauncher(sandbox, ["--background"]).status === 0);
  check(
    "2.0 made the new project's daily backup",
    await until(() => projectBackups(sandbox.data) >= 1, 60_000),
    projectBackups(sandbox.data),
  );
  check(
    "2.0 serving after the restart",
    await until(() => sandbox.serviceVersion() === V20, 30_000),
    sandbox.serviceVersion(),
  );
  return sandbox.serviceVersion() === V20;
}

/** 2.x 的项目备份条数（只读打开 registry）。 */
function projectBackups(root: string): number {
  const path = join(root, "registry", "registry.sqlite");
  if (!existsSync(path)) return 0;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT count(*) AS n FROM backup_catalog WHERE scope = 'PROJECT'")
      .get() as { n: number };
    return Number(row.n);
  } finally {
    db.close();
  }
}

/** registry 的全局事件条数：2.0 在两次比较之间有没有自己写过东西。 */
function globalEvents(root: string): number {
  const db = new DatabaseSync(join(root, "registry", "registry.sqlite"), { readOnly: true });
  try {
    return Number((db.prepare("SELECT count(*) AS n FROM global_events").get() as { n: number }).n);
  } finally {
    db.close();
  }
}

async function rollbackTo20(sandbox: Sandbox, label: string): Promise<void> {
  const code = runSetup(sandbox, join(sandbox.install, "atm-setup.exe"), ["--rollback", "--quiet"]);
  check(`${label}: rollback exit 0 (${code})`, code === 0, sandbox.log(6));
  check(
    `${label}: app.json.current = ${V20}`,
    sandbox.pointer()?.current === V20,
    sandbox.pointer(),
  );
  check(
    `${label}: 2.0 serving again`,
    await until(() => sandbox.serviceVersion() === V20, 30_000),
    sandbox.serviceVersion(),
  );
  const a = authorityOf(sandbox);
  check(
    `${label}: A=legacy by setup-rollback, bound to ${generationOf(sandbox)}`,
    a?.authority === "legacy" &&
      a.by === "setup-rollback" &&
      a.generation === generationOf(sandbox),
    a,
  );
  check(
    `${label}: no 3.x process left under app-${VERSION_A}`,
    processes(join(sandbox.install, `app-${VERSION_A}`)).length === 0,
  );
}

async function upgradeTo3(sandbox: Sandbox, label: string): Promise<number> {
  const code = runSetup(sandbox, pkg3().setup, ["install", pkg3().manifest, "--quiet"]);
  check(`${label}: upgrade exit 0 (${code})`, code === 0, sandbox.log(8));
  await installed(sandbox, VERSION_A, V20);
  return code;
}

let packagesForV3: Packages | null = null;
const pkg3 = () => packagesForV3!.a;

/**
 * 2.0 (two processes) → 3.x (single process, converts L into N) → undo → rollback to 2.0 →
 * re-upgrade, in the three ways 07 §6 tells apart after a rollback: 2.x untouched (resume
 * with nothing lost), 2.x written (reconvert from 2.x), 2.x not comparable (SOURCE_CONFLICT:
 * setup waits for the user's choice, not for "progress"; nobody chooses, the cap ends the
 * wait, setup confirms the process exited and rolls back). Each step records both roots'
 * business content.
 */
async function scenarioV2V3(pkg: Packages): Promise<void> {
  currentScenario = "v2-v3";
  packagesForV3 = pkg;
  const sandbox = new Sandbox("v2-v3");
  reset(sandbox);
  process.stdout.write(`\n[${currentScenario}] 2.0 installed, data written by 2.0\n`);
  if (!(await install20(sandbox))) return teardown(sandbox);
  const before = summarize(sandbox, "2.0 installed");
  check("L has DRL and DRL-D-001", hasRecord(before.L, "升级前写入"), before.L);
  check("no N yet", before.N === null && before.authority === null, before);

  process.stdout.write(`[${currentScenario}] upgrade 2.0 → ${VERSION_A} (conversion)\n`);
  await upgradeTo3(sandbox, "upgrade");
  const upgraded = summarize(sandbox, `upgraded to ${VERSION_A}`);
  const g1 = upgraded.generation;
  check("N has exactly L's business content", sameBusiness(upgraded.L, upgraded.N), upgraded);
  check("L is unchanged by the conversion", sameBusiness(upgraded.L, before.L), upgraded.L);
  check(
    "A=v3 by publish, bound to the published generation",
    upgraded.authority?.authority === "v3" &&
      upgraded.authority.by === "publish" &&
      upgraded.authority.generation === g1 &&
      g1 !== null,
    upgraded.authority,
  );
  check(
    "2.0 no longer serves (L\\runtime lease released)",
    processes(join(sandbox.install, `app-${V20}`)).length === 0,
  );
  check(
    "3.x CLI writes DRL-D-002 into N",
    record((args) => cli3(sandbox, VERSION_A, args), "升级后写入", "3.0 写的"),
  );
  const written3 = summarize(sandbox, "written in 3.x");
  check(
    "the 3.x write is in N, not in L",
    hasRecord(written3.N, "升级后写入") && !hasRecord(written3.L, "升级后写入"),
  );

  process.stdout.write(`[${currentScenario}] roll back to 2.0\n`);
  const eventsBefore = globalEvents(sandbox.data);
  await rollbackTo20(sandbox, "rollback 1");
  const back1 = summarize(sandbox, "rolled back to 2.0");
  check(
    "2.0 restarted by the rollback wrote nothing of its own (no new global event)",
    globalEvents(sandbox.data) === eventsBefore,
    { before: eventsBefore, after: globalEvents(sandbox.data) },
  );
  check("2.0 serves L as it was before the upgrade", sameBusiness(back1.L, before.L), back1.L);
  check("N is kept as it was (3.x write included)", sameBusiness(back1.N, written3.N), back1.N);

  process.stdout.write(`[${currentScenario}] re-upgrade, 2.x untouched → resume\n`);
  await upgradeTo3(sandbox, "re-upgrade unchanged");
  const resumed = summarize(sandbox, "re-upgraded, 2.x untouched");
  check(
    "same generation (resumed, not reconverted)",
    resumed.generation === g1,
    resumed.generation,
  );
  check(
    "A=v3 by resume-after-rollback",
    resumed.authority?.authority === "v3" && resumed.authority.by === "resume-after-rollback",
    resumed.authority,
  );
  check("nothing lost: N still has the 3.x write", sameBusiness(resumed.N, written3.N), resumed.N);

  process.stdout.write(`[${currentScenario}] roll back, write in 2.0, re-upgrade → reconvert\n`);
  await rollbackTo20(sandbox, "rollback 2");
  check(
    "2.0 CLI writes DRL-D-002 after the rollback",
    record((args) => cli20(sandbox, args), "回滚后写入", "回到 2.0 之后写的"),
  );
  const written2 = summarize(sandbox, "written in 2.0 after the rollback");
  await upgradeTo3(sandbox, "re-upgrade changed");
  const reconverted = summarize(sandbox, "re-upgraded, 2.x written");
  const g2 = reconverted.generation;
  check("a new generation (reconverted from 2.x)", g2 !== null && g2 !== g1, { g1, g2 });
  check("N is 2.x's content now", sameBusiness(reconverted.N, written2.L), reconverted);
  check(
    "the 2.x write is in, the superseded 3.x-only write is not",
    hasRecord(reconverted.N, "回滚后写入") && !hasRecord(reconverted.N, "升级后写入"),
    reconverted.N,
  );
  check(
    "the superseded generation is sealed under N\\superseded, not deleted",
    existsSync(join(sandbox.v3, "superseded")) &&
      readdirSync(join(sandbox.v3, "superseded")).length > 0,
    readdirSync(sandbox.v3),
  );

  process.stdout.write(
    `[${currentScenario}] roll back, 2.x not comparable, re-upgrade → SOURCE_CONFLICT\n`,
  );
  await rollbackTo20(sandbox, "rollback 3");
  const back3 = summarize(sandbox, "rolled back again");
  writeFileSync(join(sandbox.data, "stray.bin"), "not a 2.x file");
  const mark = sandbox.logMark();
  const started = Date.now();
  // Drill-only wait budget (first progress 60 s, stall 5 s, cap 40 s): a stall rule that still
  // applied would end the wait 5 s after the conflict; the cap ends it instead.
  const code = runSetup(sandbox, pkg3().setup, ["install", pkg3().manifest, "--quiet"], {
    ATM_SETUP_WAIT_SECS: "60,5,40",
  });
  const waited = (Date.now() - started) / 1000;
  const log = sandbox.since(mark);
  check(
    `unknown: setup did not commit (exit ${code}, ${waited.toFixed(0)} s)`,
    code !== 0,
    log.slice(-600),
  );
  check(
    "unknown: setup saw the conflict and waited for the user's choice",
    /SOURCE_CONFLICT, waiting for the user to choose the data source/u.test(log),
    log.slice(-800),
  );
  check(
    "unknown: the cap ended the wait, not the stall rule",
    /START_TIMEOUT: the data source was not chosen within/u.test(log) && !/START_STUCK/u.test(log),
    log.slice(-800),
  );
  check(
    "unknown: journal ROLLED_BACK",
    sandbox.journal()?.outcome === "ROLLED_BACK",
    sandbox.journal(),
  );
  check(
    `unknown: app.json.current = ${V20}`,
    sandbox.pointer()?.current === V20,
    sandbox.pointer(),
  );
  check(
    "unknown: 2.0 serving again",
    await until(() => sandbox.serviceVersion() === V20, 30_000),
    sandbox.serviceVersion(),
  );
  check(
    `unknown: the 3.x host exited before the rollback (no process under app-${VERSION_A})`,
    processes(join(sandbox.install, `app-${VERSION_A}`)).length === 0,
  );
  const conflicted = summarize(sandbox, "re-upgrade with 2.x not comparable, rolled back");
  check("unknown: L untouched", sameBusiness(conflicted.L, back3.L), conflicted.L);
  check(
    "unknown: N untouched (same generation, same content)",
    conflicted.generation === g2 && sameBusiness(conflicted.N, back3.N),
    conflicted,
  );
  check(
    "unknown: A=legacy by setup-rollback again",
    conflicted.authority?.authority === "legacy" && conflicted.authority.by === "setup-rollback",
    conflicted.authority,
  );
  check(
    "unknown: the rollback cleared the conflict state (2.x is the source again)",
    !existsSync(join(sandbox.v3, "runtime", "startup-state.json")),
  );

  process.stdout.write(`[${currentScenario}] 2.x readable again, re-upgrade → resume\n`);
  rmSync(join(sandbox.data, "stray.bin"));
  await upgradeTo3(sandbox, "re-upgrade after the conflict");
  const last = summarize(sandbox, "re-upgraded after the conflict");
  check("resumed the same generation", last.generation === g2, last.generation);
  check("N is what it was", sameBusiness(last.N, back3.N), last.N);
  teardown(sandbox);
}

/**
 * 2.0 → 3.x with setup killed at every commit point (and in the middle of the undo a failed
 * START began, and right after it spawned the converting host). The next ordinary start —
 * whichever launcher the root has at that moment — recovers: committed with N holding L's
 * business content, or back on 2.0 with L untouched and `A` matching how far the
 * conversion durably got (not published: no `A`; published: `A=legacy by setup-rollback`).
 */
async function scenarioV2V3Faults(pkg: Packages): Promise<void> {
  currentScenario = "v2-v3-faults";
  packagesForV3 = pkg;
  const sandbox = new Sandbox("v2-v3-faults");
  const expected: Array<[string, "ABORTED" | "ROLLED_BACK" | "COMMITTED"]> = [
    ["STAGE", "ABORTED"],
    ["PROBE", "ABORTED"],
    ["SNAPSHOT", "ABORTED"],
    ["FENCE", "ABORTED"],
    ["QUIESCE", "ABORTED"],
    ["SEAL", "ABORTED"],
    ["SWITCH", "ROLLED_BACK"],
    ["START", "ROLLED_BACK"],
    // 刚拉起转换宿主就死：宿主准入时自己跑 --recover 并等它；那一轮 recover 不接管这个卡在准入的宿主，
    // 先确认它退出再回滚（以前是互等到首条进度期限 60 s）。
    ["SPAWNED:START", "ROLLED_BACK"],
    // 宿主已经转换完、拿到 lease 才死：下一次启动的 recover 接管同一个宿主的等待，提交。
    ["LEASED:START", "COMMITTED"],
    ["UNDO:2", "ROLLED_BACK"],
    ["COMMIT", "COMMITTED"],
  ];
  // 只复现其中几点：ATM_DRILL_POINTS=SPAWNED:START,COMMIT。
  const points = process.env.ATM_DRILL_POINTS?.split(",");
  for (const [point, outcome] of expected) {
    if (points && !points.includes(point)) continue;
    process.stdout.write(`\n[${currentScenario}] 2.0 → ${VERSION_A}, die after ${point}\n`);
    reset(sandbox);
    if (!(await install20(sandbox))) continue;
    const before = legacyBusiness(sandbox.data);
    const extra: Record<string, string> =
      point === "UNDO:2"
        ? { ATM_SETUP_FAIL_AT: "START", ATM_SETUP_DIE_AFTER: "UNDO:2" }
        : { ATM_SETUP_DIE_AFTER: point };
    const code = runSetup(sandbox, pkg.a.setup, ["install", pkg.a.manifest, "--quiet"], extra);
    check(`${point}: setup died (99)`, code === 99, { code, log: sandbox.log(4) });
    check(
      `${point}: journal left unfinished`,
      sandbox.journal()?.outcome == null,
      sandbox.journal(),
    );
    const mark = sandbox.logMark();
    const begun = Date.now();
    const start = runLauncher(sandbox, ["--background"]);
    check(
      `${point}: the root launcher's start exits 0 within 90 s (${((Date.now() - begun) / 1000).toFixed(1)} s)`,
      start.status === 0 && Date.now() - begun < 90_000,
      { status: start.status, err: start.stderr.slice(0, 300) },
    );
    check(
      `${point}: recovered to ${outcome}`,
      await until(
        () => sandbox.journal()?.state === "DONE" && sandbox.journal()?.outcome === outcome,
        240_000,
      ),
      { journal: sandbox.journal(), log: sandbox.since(mark).slice(-800) },
    );
    const version = outcome === "COMMITTED" ? VERSION_A : V20;
    check(
      `${point}: app.json.current = ${version}`,
      sandbox.pointer()?.current === version,
      sandbox.pointer(),
    );
    check(
      `${point}: service running ${version}`,
      await until(() => sandbox.serviceVersion() === version, 60_000),
      sandbox.serviceVersion(),
    );
    const after = summarize(sandbox, `die after ${point} → ${outcome}`);
    check(`${point}: L untouched`, sameBusiness(after.L, before), after.L);
    if (outcome === "COMMITTED") {
      check(`${point}: N holds L's business content`, sameBusiness(after.N, before), after.N);
      check(
        `${point}: A=v3, bound to the published generation`,
        after.authority?.authority === "v3" && after.authority.generation === after.generation,
        after.authority,
      );
    } else {
      check(
        `${point}: no 3.x process left`,
        processes(join(sandbox.install, `app-${VERSION_A}`)).length === 0,
      );
      check(
        `${point}: A matches the durable phase (published → legacy, otherwise none)`,
        after.generation === null
          ? after.authority === null
          : after.authority?.authority === "legacy" &&
              after.authority.generation === after.generation,
        { generation: after.generation, authority: after.authority },
      );
    }
    if (point === "LEASED:START")
      check(
        `${point}: the recovery took over the same host's wait`,
        /taking over the wait for host/u.test(sandbox.since(mark)),
        sandbox.since(mark).slice(-600),
      );
  }
  teardown(sandbox);
}

async function main(): Promise<void> {
  const only = process.argv.includes("--only")
    ? process.argv[process.argv.indexOf("--only") + 1]!.split(",")
    : null;
  const pkg = packages(process.argv.includes("--rebuild-packages"));
  // 演练用的假 Electron 与 job-runner 是 drill 构建的 examples：构建包之后才一定在。
  if (!existsSync(fakeElectron)) throw new Error(`DRILL_FAKE_ELECTRON_MISSING: ${fakeElectron}`);
  const scenarios: Array<[string, (pkg: Packages) => Promise<void>]> = [
    ["lifecycle", scenarioLifecycle],
    ["update", scenarioUpdate],
    ["review", scenarioReview],
    ["delayed", scenarioDelayed],
    ["job", scenarioJob],
    ["uninstall-busy", scenarioUninstallBusy],
    ["faults", scenarioFaults],
    ["migration", scenarioMigration],
    ["reverse-replay", scenarioReverseReplay],
    ["legacy-record", scenarioLegacyRecord],
    ["uninstall-race", scenarioUninstallRace],
    ["v2-v3", scenarioV2V3],
    ["v2-v3-faults", scenarioV2V3Faults],
  ];
  for (const [name, run] of scenarios) if (!only || only.includes(name)) await run(pkg);
  const failed = results.filter((result) => !result.passed);
  const report = {
    at: new Date().toISOString(),
    passed: failed.length === 0,
    total: results.length,
    failed: failed.length,
    results,
    business,
  };
  writeFileSync(join(drillRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `\n${results.length - failed.length}/${results.length} checks passed → ${join(drillRoot, "report.json")}\n`,
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
}

await main();

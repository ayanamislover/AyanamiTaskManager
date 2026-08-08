import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

type Check = { name: string; passed: boolean; detail?: string };

const root = process.cwd();
const outputRoot = join(root, "output", "distribution-smoke");
const reportPath = join(root, "output", "distribution-smoke-report.json");
const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) throw new Error("LOCALAPPDATA_MISSING");

const localAppDataRoot = resolve(localAppData);
const installRoot = resolve(localAppDataRoot, "AyanamiTaskManagerDesktop");
const defaultDataRoot = resolve(localAppDataRoot, "AyanamiTaskManager");
const deadMarker = join(installRoot, ".dead");
const uninstallRegistryKey =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AyanamiTaskManagerDesktop";
const checks: Check[] = [];

function check(name: string, condition: unknown, detail?: string): asserts condition {
  const passed = Boolean(condition);
  checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) });
  if (!passed) throw new Error(`${name}：${detail ?? "未通过"}`);
}

async function filesBelow(directory: string): Promise<string[]> {
  if (!existsSync(directory)) return [];
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await filesBelow(path)));
    else result.push(path);
  }
  return result;
}

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): void {
  const isCommandScript = process.platform === "win32" && command.toLowerCase().endsWith(".cmd");
  const executable = isCommandScript ? (process.env.ComSpec ?? "cmd.exe") : command;
  const executableArgs = isCommandScript ? ["/d", "/s", "/c", [command, ...args].join(" ")] : args;
  const result = spawnSync(executable, executableArgs, {
    cwd: root,
    env: { ...process.env, ...env, CI: "1" },
    encoding: "utf8",
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} 退出码 ${result.status}`);
}

function appProcessIsRunning(): boolean {
  const result = spawnSync(
    "tasklist.exe",
    ["/fo", "csv", "/nh", "/fi", "IMAGENAME eq AyanamiTaskManager.exe"],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`tasklist.exe 退出码 ${result.status}`);
  return /"AyanamiTaskManager\.exe"/iu.test(result.stdout);
}

function uninstallRegistrationExists(): boolean {
  const result = spawnSync("reg.exe", ["query", uninstallRegistryKey], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`reg.exe query 退出码 ${result.status}`);
}

async function productShortcuts(): Promise<string[]> {
  const shortcutRoots = [
    process.env.APPDATA
      ? resolve(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs")
      : null,
    process.env.USERPROFILE ? resolve(process.env.USERPROFILE, "Desktop") : null,
  ].filter((path): path is string => path !== null);
  const shortcuts = (
    await Promise.all(shortcutRoots.map(async (directory) => await filesBelow(directory)))
  ).flat();
  return shortcuts.filter(
    (path) =>
      path.toLowerCase().endsWith(".lnk") &&
      basename(path).toLowerCase().includes("ayanamitaskmanager"),
  );
}

function assertSafeInstallRoot(): void {
  if (
    basename(installRoot) !== "AyanamiTaskManagerDesktop" ||
    dirname(installRoot).toLowerCase() !== localAppDataRoot.toLowerCase()
  ) {
    throw new Error(`拒绝清理未验证的安装目录：${installRoot}`);
  }
}

async function cleanupDeadInstallRoot(checkName: string): Promise<void> {
  assertSafeInstallRoot();
  check(`${checkName}带有 Squirrel .dead 标记`, existsSync(deadMarker), deadMarker);
  check(`${checkName}没有运行中的应用进程`, !appProcessIsRunning());
  check(`${checkName}没有卸载注册项`, !uninstallRegistrationExists(), uninstallRegistryKey);
  const shortcuts = await productShortcuts();
  check(`${checkName}没有产品快捷方式`, shortcuts.length === 0, shortcuts.join(", "));
  await rm(installRoot, { recursive: true, force: true });
  check(`${checkName}已从精确安装路径清理`, !existsSync(installRoot), installRoot);
}

function runPackagedSmoke(label: string, executable: string): void {
  const slug = label === "portable" ? "portable" : "installed";
  run(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["smoke:packaged"], {
    ATM_PACKAGED_EXE: executable,
    ATM_SMOKE_DATA_DIR: join(outputRoot, `${slug}-data`),
    ATM_SMOKE_REPORT: join(root, "output", `${slug}-smoke-report.json`),
  });
}

async function waitForInstalledExecutable(timeoutMs = 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const executable = (await filesBelow(installRoot)).find(
      (path) => basename(path).toLowerCase() === "ayanamitaskmanager.exe",
    );
    if (executable) return executable;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`安装后 ${timeoutMs}ms 内未找到 AyanamiTaskManager.exe`);
}

async function waitForUninstallState(
  installedExecutable: string,
  timeoutMs = 60_000,
): Promise<"removed" | "dead"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const physicallyRemoved = !existsSync(installedExecutable);
    const markedDead = existsSync(deadMarker);
    const processStopped = !appProcessIsRunning();
    const registrationRemoved = !uninstallRegistrationExists();
    const shortcutsRemoved = (await productShortcuts()).length === 0;
    if (
      (physicallyRemoved || markedDead) &&
      processStopped &&
      registrationRemoved &&
      shortcutsRemoved
    ) {
      return physicallyRemoved ? "removed" : "dead";
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`卸载后 ${timeoutMs}ms 内未进入完整卸载状态`);
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const makeFiles = await filesBelow(join(root, "out", "make"));
const setup = makeFiles.find(
  (path) => path.toLowerCase().endsWith(".exe") && basename(path).toLowerCase().includes("setup"),
);
const portableZip = makeFiles.find((path) => path.toLowerCase().endsWith(".zip"));
check("Forge Setup 存在", setup, setup);
check("Forge portable ZIP 存在", portableZip, portableZip);
check(
  "安装目录与用户数据目录隔离",
  installRoot.toLowerCase() !== defaultDataRoot.toLowerCase(),
  `${installRoot} != ${defaultDataRoot}`,
);
let priorInstallFiles = await filesBelow(installRoot);
if (
  priorInstallFiles.some((path) => basename(path).toLowerCase() === "ayanamitaskmanager.exe") &&
  existsSync(deadMarker)
) {
  await cleanupDeadInstallRoot("验收前遗留的已卸载目录");
  priorInstallFiles = await filesBelow(installRoot);
}
check(
  "验收前没有活跃同名安装",
  !priorInstallFiles.some((path) => basename(path).toLowerCase() === "ayanamitaskmanager.exe"),
  installRoot,
);
check("验收前没有运行中的同名进程", !appProcessIsRunning());
check("验收前没有同名卸载注册项", !uninstallRegistrationExists(), uninstallRegistryKey);
const priorShortcuts = await productShortcuts();
check("验收前没有同名产品快捷方式", priorShortcuts.length === 0, priorShortcuts.join(", "));

let installedExecutable: string | null = null;
let uninstallState: "removed" | "dead" | null = null;
try {
  const portableRoot = join(outputRoot, "portable");
  await mkdir(portableRoot, { recursive: true });
  run("tar.exe", ["-xf", portableZip, "-C", portableRoot]);
  const portableExecutable = (await filesBelow(portableRoot)).find(
    (path) => basename(path).toLowerCase() === "ayanamitaskmanager.exe",
  );
  check("portable ZIP 可解压", portableExecutable, portableRoot);
  runPackagedSmoke("portable", portableExecutable);
  const portableReport = JSON.parse(
    await readFile(join(root, "output", "portable-smoke-report.json"), "utf8"),
  ) as { passed: boolean; checks: Check[] };
  check("portable 首启/退出/重启与数据持久化", portableReport.passed);

  run(setup, ["--silent"]);
  installedExecutable = await waitForInstalledExecutable();
  check("Squirrel Setup 可静默安装", existsSync(installedExecutable), installedExecutable);
  check("Squirrel 卸载注册项已创建", uninstallRegistrationExists(), uninstallRegistryKey);
  runPackagedSmoke("installed", installedExecutable);
  const installedReport = JSON.parse(
    await readFile(join(root, "output", "installed-smoke-report.json"), "utf8"),
  ) as { passed: boolean; dataDir: string; checks: Check[] };
  check("安装版首启/退出/重启与数据持久化", installedReport.passed);

  const preservedMarker = join(installedReport.dataDir, "uninstall-preservation.marker");
  await writeFile(preservedMarker, "AyanamiTaskManager user data preservation proof\n", "utf8");
  const updater = join(installRoot, "Update.exe");
  check("Squirrel 卸载器存在", existsSync(updater), updater);
  run(updater, ["--uninstall", "-s"]);
  uninstallState = await waitForUninstallState(installedExecutable);
  check("卸载后应用进程已退出", !appProcessIsRunning());
  check("卸载后卸载注册项已移除", !uninstallRegistrationExists(), uninstallRegistryKey);
  const remainingShortcuts = await productShortcuts();
  check("卸载后产品快捷方式已移除", remainingShortcuts.length === 0, remainingShortcuts.join(", "));
  check(
    "卸载后安装目录已移除或被 Squirrel 标记为已卸载",
    !existsSync(installedExecutable) || existsSync(deadMarker),
    `${uninstallState}: ${installedExecutable}`,
  );
  check("卸载后用户数据仍保留", existsSync(preservedMarker), preservedMarker);
  if (uninstallState === "dead") {
    await cleanupDeadInstallRoot("烟测产生的已卸载目录");
  }

  const report = {
    passed: true,
    completedAt: new Date().toISOString(),
    setup,
    portableZip,
    installRoot,
    defaultDataRoot,
    installedExecutable,
    uninstallState,
    checks,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  const report = {
    passed: false,
    completedAt: new Date().toISOString(),
    setup,
    portableZip,
    installRoot,
    defaultDataRoot,
    installedExecutable,
    uninstallState,
    checks,
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  throw error;
}

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

const installRoot = resolve(localAppData, "AyanamiTaskManagerDesktop");
const defaultDataRoot = resolve(localAppData, "AyanamiTaskManager");
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
const priorInstallFiles = await filesBelow(installRoot);
check(
  "验收前没有活跃同名安装",
  !priorInstallFiles.some((path) => basename(path).toLowerCase() === "ayanamitaskmanager.exe"),
  installRoot,
);

let installedExecutable: string | null = null;
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
  check("卸载后安装版程序已移除", !existsSync(installedExecutable), installedExecutable);
  check("卸载后用户数据仍保留", existsSync(preservedMarker), preservedMarker);

  const report = {
    passed: true,
    completedAt: new Date().toISOString(),
    setup,
    portableZip,
    installRoot,
    defaultDataRoot,
    installedExecutable,
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
    checks,
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  throw error;
}

/**
 * 发布阶段 10：用**生产二进制**验收发出去的两种形态（de-electron §9「最终候选单独跑」）。
 *
 * packaged-smoke 验行为，用的是带 smoke feature 的测试宿主（能开 CDP、接受烟测专用的退出命令）；
 * 这里验的是用户真正拿到的那份：
 *
 *   便携 zip   解压 → 启动 → 服务健康 → SHOW 后窗口与 WebView 起来 → 注入的 WebView2 调试参数
 *              与用户数据目录被宿主清掉，没有调试端口
 *   安装包     atm-setup.exe install → 登记（app.json、current、卸载项、开始菜单与「ATM 修复」）
 *              → 同上的运行检查与界面就绪见证 → --uninstall → 登记全部撤掉、用户数据保留
 *
 * 安装那一半会写真实的 HKCU 卸载项与开始菜单，只能在干净的机器上跑（CI 每次都是）。机器上已有
 * 安装时照旧报错；release-and-install 要保留现有安装去走迁移时，显式设
 * ATM_DISTRIBUTION_SKIP_INSTALLED=1，报告里记下跳过，不写 installed 报告——INSTALLED 层随之缺席。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { describeAppProcesses, parseTasklistCsv, type AppProcess } from "./app-processes.js";
import { applyRunRestore, loginItemRestorePlan, readRunSnapshot } from "./login-item-guard.js";
import { portableZipName } from "./package-native.js";
import {
  assertSafeInstallRoot as assertInstallRootIsProduct,
  findProductShortcuts,
} from "./product-install-sites.js";
import { resolveSystemTar } from "./system-tar.js";

type Check = { name: string; passed: boolean; detail?: string };
type Runtime = { endpoint: string; token: string; pid: number; version: string };

const root = process.cwd();
const packageDir = join(root, "output", "package");
const outputRoot = join(root, "output", "distribution-smoke");
const reportPath = join(root, "output", "distribution-smoke-report.json");
const packageVersion = (
  JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string }
).version;
const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) throw new Error("LOCALAPPDATA_MISSING");

const localAppDataRoot = resolve(localAppData);
const installRoot = resolve(localAppDataRoot, "AyanamiTaskManagerDesktop");
const uninstallRegistryKey =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AyanamiTaskManagerDesktop";
const skipInstalled = process.env.ATM_DISTRIBUTION_SKIP_INSTALLED === "1";
const checks: Check[] = [];

function check(name: string, condition: unknown, detail?: string): asserts condition {
  const passed = Boolean(condition);
  checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) });
  if (!passed) throw new Error(`${name}：${detail ?? "未通过"}`);
}

const delay = (milliseconds: number) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function waitUntil<T>(read: () => Promise<T | null>, timeoutMs = 30_000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value !== null) return value;
    } catch {
      // 文件写到一半、服务还没 listen：下一轮再看。
    }
    await delay(200);
  }
  return null;
}

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): number {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "inherit",
    windowsHide: true,
    timeout: 300_000,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function appProcesses(): AppProcess[] {
  const result = spawnSync(
    "tasklist.exe",
    ["/fo", "csv", "/nh", "/fi", "IMAGENAME eq AyanamiTaskManager.exe"],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`tasklist.exe 退出码 ${result.status}`);
  return parseTasklistCsv(result.stdout);
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

/**
 * 宿主有没有可见的应用窗口（标题 AyanamiTaskManager）。不能用 MainWindowHandle：tao 的事件
 * 线程挂着一个 16×16 的透明工具窗口，它带 WS_VISIBLE，后台运行时会被当成「主窗口」。
 */
const WINDOW_PROBE = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class AtmWindows {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static int Count(uint target) {
    int count = 0;
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      var title = new StringBuilder(64); GetWindowText(h, title, 64);
      if (pid == target && IsWindowVisible(h) && title.ToString() == "AyanamiTaskManager") count++;
      return true;
    }, IntPtr.Zero);
    return count;
  }
}
"@
`;

function appWindowVisible(pid: number): boolean {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", `${WINDOW_PROBE}[AtmWindows]::Count(${pid})`],
    { encoding: "utf8", windowsHide: true },
  );
  return Number(result.stdout.trim()) > 0;
}

/**
 * 生产二进制的运行检查。宿主已在运行（安装事务 START 拉起的）就直接用；否则后台启动。
 * 环境里故意塞 WebView2 的调试参数和另一个用户数据目录：生产宿主必须在建任何进程前把它们
 * 清掉，于是既不会出现调试端口，也不会在那个目录里写东西。
 */
async function productionChecks(
  label: "portable" | "installed",
  executable: string,
  dataDir: string,
): Promise<{ child: ChildProcess | null; runtime: Runtime; hostPid: number }> {
  const decoy = join(outputRoot, `${label}-webview2-decoy`);
  const env = {
    ...process.env,
    ATM_DATA_DIR: dataDir,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=0",
    WEBVIEW2_USER_DATA_FOLDER: decoy,
  };
  const runtimePath = join(dataDir, "runtime", "daemon.json");
  const child = existsSync(runtimePath)
    ? null
    : spawn(executable, ["--background"], { env, stdio: "ignore", windowsHide: true });
  const runtime = await waitUntil(async () => {
    const value = JSON.parse(await readFile(runtimePath, "utf8")) as Runtime;
    const response = await fetch(`${value.endpoint}/api/v1/system/status`, {
      headers: { authorization: `Bearer ${value.token}` },
    });
    return response.ok ? value : null;
  }, 60_000);
  check(`${label}：服务健康`, runtime, runtimePath);
  check(`${label}：服务版本是本次候选`, runtime.version === packageVersion, runtime.version);

  const hostRecord = JSON.parse(readFileSync(join(dataDir, "runtime", "host.json"), "utf8")) as {
    pid: number;
  };
  check(`${label}：后台启动不建窗口`, !appWindowVisible(hostRecord.pid), String(hostRecord.pid));
  run(executable, [], env);
  const shown = await waitUntil(
    async () => (appWindowVisible(hostRecord.pid) ? true : null),
    20_000,
  );
  check(`${label}：SHOW 后宿主窗口可见`, shown, String(hostRecord.pid));
  const webviewProfile = join(dataDir, "webview", "EBWebView");
  check(
    `${label}：WebView 在数据根下建起来`,
    await waitUntil(async () => (existsSync(webviewProfile) ? true : null), 20_000),
    webviewProfile,
  );
  // 有调试端口的话 Chromium 起来就写；多等几秒再断言「没有」。
  await delay(4_000);
  check(
    `${label}：注入的调试参数无效，没有调试端口`,
    !existsSync(join(webviewProfile, "DevToolsActivePort")) &&
      !existsSync(join(decoy, "EBWebView", "DevToolsActivePort")),
    webviewProfile,
  );
  check(`${label}：注入的 WebView2 用户数据目录无效`, !existsSync(decoy), decoy);
  return { child, runtime, hostPid: hostRecord.pid };
}

function killTree(pid: number): void {
  spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
}

async function writeSmokeReport(label: string, dataDir: string, from: number): Promise<void> {
  const own = checks.slice(from);
  await writeFile(
    join(root, "output", `${label}-smoke-report.json`),
    `${JSON.stringify(
      {
        passed: own.every((entry) => entry.passed),
        completedAt: new Date().toISOString(),
        dataDir,
        checks: own,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function portable(): Promise<void> {
  const from = checks.length;
  const zip = join(packageDir, portableZipName(packageVersion));
  check("便携 zip 存在", existsSync(zip), zip);
  const portableRoot = join(outputRoot, "portable");
  await mkdir(portableRoot, { recursive: true });
  check("便携 zip 可解压", run(resolveSystemTar(), ["-xf", zip, "-C", portableRoot]) === 0, zip);
  const appDir = join(portableRoot, `AyanamiTaskManager-${packageVersion}`);
  const executable = join(appDir, "AyanamiTaskManager.exe");
  check("便携目录带 portable 标记", existsSync(join(appDir, "portable")), appDir);
  const dataDir = join(outputRoot, "portable-data");
  const { hostPid } = await productionChecks("portable", executable, dataDir);
  // 生产宿主没有 SMOKE_QUIT；干净退出由 packaged-smoke 验，这里按进程树结束。
  killTree(hostPid);
  check(
    "便携：结束后没有残留进程",
    await waitUntil(async () =>
      appProcesses().every((entry) => entry.pid !== hostPid) ? true : null,
    ),
    String(hostPid),
  );
  await writeSmokeReport("portable", dataDir, from);
}

async function installed(): Promise<"verified" | "skipped"> {
  const preexisting =
    existsSync(join(installRoot, "app.json")) ||
    existsSync(join(installRoot, "Update.exe")) ||
    uninstallRegistrationExists();
  if (preexisting && skipInstalled) {
    checks.push({
      name: "已有安装：按 ATM_DISTRIBUTION_SKIP_INSTALLED 跳过安装验收",
      passed: true,
      detail: installRoot,
    });
    return "skipped";
  }
  assertInstallRootIsProduct(installRoot, localAppDataRoot);
  check("验收前没有同名安装", !preexisting, installRoot);
  const running = appProcesses();
  check("验收前没有运行中的同名进程", running.length === 0, describeAppProcesses(running));
  const priorShortcuts = await findProductShortcuts();
  check("验收前没有同名产品快捷方式", priorShortcuts.length === 0, priorShortcuts.join(", "));

  const from = checks.length;
  const dataDir = join(outputRoot, "installed-data");
  const manifest = join(packageDir, `atm-${packageVersion}-win-x64.json`);
  const setup = join(packageDir, "atm-setup.exe");
  const runBefore = readRunSnapshot();
  /** 卸载这一步删掉的 Run 值名（卸载前在、卸载后没了）；卸载没跑就是空的。 */
  let runDeletedByUninstall: string[] = [];
  try {
    check(
      "atm-setup 静默安装",
      run(setup, ["install", manifest, "--quiet"], { ATM_DATA_DIR: dataDir }) === 0,
      manifest,
    );
    const pointer = JSON.parse(await readFile(join(installRoot, "app.json"), "utf8")) as {
      current: string;
    };
    check("app.json 指向本次版本", pointer.current === packageVersion, pointer.current);
    check("卸载注册项已创建", uninstallRegistrationExists(), uninstallRegistryKey);
    const shortcuts = await findProductShortcuts();
    check(
      "开始菜单有应用与「ATM 修复」",
      shortcuts.length >= 2 && shortcuts.some((path) => path.includes("修复")),
      shortcuts.join(", "),
    );
    const launcher = join(installRoot, "AyanamiTaskManager.exe");
    check("安装根有启动器", existsSync(launcher), launcher);
    await productionChecks("installed", launcher, dataDir);
    check(
      "界面就绪见证已写（renderer 真加载了）",
      await waitUntil(async () =>
        existsSync(join(installRoot, "state", "health", `ui-${packageVersion}.json`)) ? true : null,
      ),
      join(installRoot, "state", "health"),
    );

    const runBeforeUninstall = readRunSnapshot();
    const preservedMarker = join(dataDir, "uninstall-preservation.marker");
    await writeFile(preservedMarker, "AyanamiTaskManager user data preservation proof\n", "utf8");
    check(
      "atm-setup 静默卸载",
      run(join(installRoot, "atm-setup.exe"), ["--uninstall", "--quiet"], {
        ATM_DATA_DIR: dataDir,
      }) === 0,
    );
    // 安装根里的 setup 删不掉正在运行的自己：它把卸载交给 %TEMP% 里的副本继续做，自己先返回。
    await waitUntil(
      async () =>
        (!existsSync(installRoot) || (await readdir(installRoot)).length === 0) &&
        !uninstallRegistrationExists() &&
        appProcesses().length === 0
          ? true
          : null,
      120_000,
    );
    const runAfterUninstall = readRunSnapshot();
    runDeletedByUninstall = Object.keys(runBeforeUninstall).filter(
      (name) => !(name in runAfterUninstall),
    );
    const left = appProcesses();
    check("卸载后应用进程已退出", left.length === 0, describeAppProcesses(left));
    check("卸载后卸载注册项已移除", !uninstallRegistrationExists(), uninstallRegistryKey);
    const remaining = await findProductShortcuts();
    check("卸载后产品快捷方式已移除", remaining.length === 0, remaining.join(", "));
    check(
      "卸载后安装根已清空",
      !existsSync(installRoot) || (await readdir(installRoot)).length === 0,
      installRoot,
    );
    check("卸载后用户数据仍保留", existsSync(preservedMarker), preservedMarker);
    await writeSmokeReport("installed", dataDir, from);
    return "verified";
  } finally {
    // 安装写的自启指向安装根的启动器（现值还指向它就是本轮写的）；卸载删掉的是上面记下的那些名字。
    applyRunRestore(
      loginItemRestorePlan(runBefore, readRunSnapshot(), {
        executables: [join(installRoot, "AyanamiTaskManager.exe")],
        deleted: runDeletedByUninstall,
      }),
    );
  }
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
let installedState: "verified" | "skipped" | null = null;
try {
  await portable();
  installedState = await installed();
  const report = {
    passed: true,
    completedAt: new Date().toISOString(),
    packageDir,
    installRoot,
    installed: installedState,
    checks,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  const report = {
    passed: false,
    completedAt: new Date().toISOString(),
    packageDir,
    installRoot,
    installed: installedState,
    checks,
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  throw error;
}

/**
 * distribution-smoke 两半共用的部分：检查记录、生产二进制的运行检查、进程与窗口探测。
 *
 * 3.x 是单进程：宿主自己就是服务，运行文件（runtime\daemon.json、host.json）与 WebView 数据都在
 * 3.0 根 N。便携那一半把 L（ATM_DATA_DIR）和 N（ATM3_DATA_DIR）都指到 output/ 下；安装那一半只在
 * 干净机器上跑，用产品默认的根（那就是用户拿到的样子）。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { agentFetch } from "./agent-fetch.js";
import { parseTasklistCsv, type AppProcess } from "./app-processes.js";
import { withPowerShellScratch } from "./powershell-scratch.js";

export type Check = { name: string; passed: boolean; detail?: string };
export type Runtime = { endpoint: string; token: string; pid: number; version: string };

export const root = process.cwd();
export const packageDir = join(root, "output", "package");
export const outputRoot = join(root, "output", "distribution-smoke");
export const reportPath = join(root, "output", "distribution-smoke-report.json");
export const packageVersion = (
  JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string }
).version;

const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) throw new Error("LOCALAPPDATA_MISSING");
export const localAppDataRoot = resolve(localAppData);
/** 产品默认的三个根：2.x 数据根 L、3.0 根 N、安装根。 */
export const realL = join(localAppDataRoot, "AyanamiTaskManager");
export const realN = join(localAppDataRoot, "AyanamiTaskManager3");
export const installRoot = join(localAppDataRoot, "AyanamiTaskManagerDesktop");
/** 会把宿主指到别处的数据根覆盖；安装那一半要用产品默认的根，先把它们都去掉。 */
export const DATA_ROOT_OVERRIDES = ["ATM_DATA_DIR", "AYANAMI_TASK_DATA_DIR", "ATM3_DATA_DIR"];

export const checks: Check[] = [];

export function check(name: string, condition: unknown, detail?: string): asserts condition {
  const passed = Boolean(condition);
  checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) });
  if (!passed) throw new Error(`${name}：${detail ?? "未通过"}`);
}

export const delay = (milliseconds: number) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

export async function waitUntil<T>(
  read: () => Promise<T | null>,
  timeoutMs = 30_000,
): Promise<T | null> {
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

export function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): number {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: "inherit",
    windowsHide: true,
    timeout: 300_000,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function appProcesses(): AppProcess[] {
  const result = spawnSync(
    "tasklist.exe",
    ["/fo", "csv", "/nh", "/fi", "IMAGENAME eq AyanamiTaskManager.exe"],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`tasklist.exe 退出码 ${result.status}`);
  return parseTasklistCsv(result.stdout);
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
  const result = withPowerShellScratch((env) =>
    spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `${WINDOW_PROBE}[AtmWindows]::Count(${pid})`],
      { encoding: "utf8", windowsHide: true, env },
    ),
  );
  return Number(result.stdout.trim()) > 0;
}

/** 宿主这次运行用的根。`l` 为 null：用产品默认的根（只在干净机器上的安装那一半）。 */
export type HostRoots = { l: string; n: string } | { l: null; n: string };

/** 宿主的环境：隔离运行把两个根都显式给出；产品默认运行去掉所有数据根覆盖。 */
export function hostEnvironment(roots: HostRoots): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !DATA_ROOT_OVERRIDES.includes(key.toUpperCase())),
  );
  return roots.l === null ? env : { ...env, ATM_DATA_DIR: roots.l, ATM3_DATA_DIR: roots.n };
}

/**
 * 生产二进制的运行检查。宿主已在运行（安装事务 START 拉起的）就直接用；否则后台启动。
 * 环境里故意塞 WebView2 的调试参数和另一个用户数据目录：生产宿主必须在建任何进程前把它们
 * 清掉，于是既不会出现调试端口，也不会在那个目录里写东西。
 */
export async function productionChecks(
  label: "portable" | "installed",
  executable: string,
  roots: HostRoots,
): Promise<{ child: ChildProcess | null; runtime: Runtime; hostPid: number }> {
  const decoy = join(outputRoot, `${label}-webview2-decoy`);
  const env = {
    ...hostEnvironment(roots),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=0",
    WEBVIEW2_USER_DATA_FOLDER: decoy,
  };
  const runtimePath = join(roots.n, "runtime", "daemon.json");
  const child = existsSync(runtimePath)
    ? null
    : spawn(executable, ["--background"], { env, stdio: "ignore", windowsHide: true });
  // 3.x 的 Agent HTTP 拒绝带 Sec-Fetch-* 的请求，Node 自带的 fetch 会带：以 Agent 身份走 node:http。
  const runtime = await waitUntil(async () => {
    const value = JSON.parse(await readFile(runtimePath, "utf8")) as Runtime;
    const response = await agentFetch(`${value.endpoint}/api/v1/system/status`, {
      headers: { authorization: `Bearer ${value.token}` },
    });
    return response.ok ? value : null;
  }, 60_000);
  check(`${label}：服务健康`, runtime, runtimePath);
  check(`${label}：服务版本是本次候选`, runtime.version === packageVersion, runtime.version);

  const hostRecord = JSON.parse(readFileSync(join(roots.n, "runtime", "host.json"), "utf8")) as {
    pid: number;
  };
  check(`${label}：后台启动不建窗口`, !appWindowVisible(hostRecord.pid), String(hostRecord.pid));
  run(executable, [], env);
  const shown = await waitUntil(
    async () => (appWindowVisible(hostRecord.pid) ? true : null),
    20_000,
  );
  check(`${label}：SHOW 后宿主窗口可见`, shown, String(hostRecord.pid));
  const webviewProfile = join(roots.n, "webview", "EBWebView");
  check(
    `${label}：WebView 在 3.0 根下建起来`,
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

export function killTree(pid: number): void {
  spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
}

export async function writeSmokeReport(
  label: string,
  dataDir: string,
  from: number,
): Promise<void> {
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

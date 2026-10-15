/**
 * distribution-smoke 两半共用的部分：检查记录、生产二进制的运行检查、进程与窗口探测。
 *
 * 3.x 是单进程：宿主自己就是服务，运行文件（runtime\daemon.json、host.json）与 WebView 数据都在
 * 3.0 根 N。便携那一半把 L（ATM_DATA_DIR）和 N（ATM3_DATA_DIR）都指到 output/ 下；安装那一半只在
 * 干净机器上跑，用产品默认的根（那就是用户拿到的样子）。
 */
// 先于一切：这里拉起的宿主窗口不抢焦点、压在最底层（scripts/test-windows.ts）。
import "./test-windows.js";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { agentFetch } from "./agent-fetch.js";
import { parseTasklistCsv, type AppProcess } from "./app-processes.js";
import type { BinarySet } from "./candidate-binaries.js";
import { withPowerShellScratch } from "./powershell-scratch.js";
import { powershellArgs } from "./windows-text.js";

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
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct GuiThreadInfo {
    public uint cbSize, flags;
    public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
    public Rect rcCaret;
  }
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint tid, ref GuiThreadInfo info);
  // 1：target 的窗口是前台窗口，或者是它线程里的活动窗口。后者不受前台锁影响：没有前台权限时，
  // 程序激活自己的窗口只是闪任务栏，但它仍是那个线程的活动窗口；有权限（例如用户几分钟没动键鼠）时就到了前台。
  // -1：看不出来（枚举失败、target 没有可见窗口、读不到线程状态），调用方当作失败，不当作「没激活」。
  public static int Activated(uint target) {
    uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    if (pid == target) return 1;
    int hit = 0, seen = 0, unreadable = 0;
    bool listed = EnumWindows((h, l) => {
      uint owner; uint tid = GetWindowThreadProcessId(h, out owner);
      if (owner != target || !IsWindowVisible(h)) return true;
      seen++;
      var info = new GuiThreadInfo(); info.cbSize = (uint)Marshal.SizeOf(typeof(GuiThreadInfo));
      if (!GetGUIThreadInfo(tid, ref info)) unreadable++;
      else if (info.hwndActive == h) hit = 1;
      return true;
    }, IntPtr.Zero);
    if (hit == 1) return 1;
    return listed && seen > 0 && unreadable == 0 ? 0 : -1;
  }
  public static int Count(uint target) {
    int count = 0;
    bool listed = EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      var title = new StringBuilder(64); GetWindowText(h, title, 64);
      if (pid == target && IsWindowVisible(h) && title.ToString() == "AyanamiTaskManager") count++;
      return true;
    }, IntPtr.Zero);
    return listed ? count : -1;
  }
}
"@
`;

/**
 * 窗口探测打印的数。探测本身失败（拉不起 PowerShell、退出码不是 0、输出不是一个非负整数、C# 返回 -1）
 * 一律抛出：负向的检查（「没有激活」）不能因为探测没跑成而算通过（W8 r8 P2-03）。
 */
export function probeValue(
  call: string,
  result: { error?: Error | undefined; status: number | null; stdout: string; stderr: string },
): number {
  const out = (result.stdout ?? "").trim();
  if (result.error || result.status !== 0 || !/^\d+$/u.test(out)) {
    throw new Error(
      `窗口探测 ${call} 失败：status=${String(result.status)} stdout=${JSON.stringify(out.slice(0, 200))} ` +
        `stderr=${JSON.stringify((result.stderr ?? "").trim().slice(0, 300))}` +
        (result.error ? ` error=${result.error.message}` : ""),
    );
  }
  return Number(out);
}

/** 跑 `[AtmWindows]::<call>`，返回它打印的数（见 {@link probeValue}）。 */
function windowProbe(call: string): number {
  const result = withPowerShellScratch((env) =>
    spawnSync("powershell.exe", powershellArgs(`${WINDOW_PROBE}[AtmWindows]::${call}`), {
      encoding: "utf8",
      windowsHide: true,
      env,
    }),
  );
  return probeValue(call, result);
}

function appWindowVisible(pid: number): boolean {
  return windowProbe(`Count(${pid})`) > 0;
}

/**
 * `pid` 的窗口被激活了没有：是前台窗口，或者是它线程里的活动窗口。只看前台会时过时不过——
 * 用户正在用电脑时前台锁挡住了激活，几分钟没动键鼠时同一次激活就真的到了前台。
 */
function activated(pid: number): boolean {
  return windowProbe(`Activated(${pid})`) === 1;
}

/** 宿主这次运行用的根。`l` 为 null：用产品默认的根（只在干净机器上的安装那一半）。 */
export type HostRoots = { l: string; n: string } | { l: null; n: string };

/**
 * 宿主的环境：隔离运行把两个根都显式给出，LOCALAPPDATA 也指到它们旁边（宿主里还有按它找默认根的
 * 地方，一律落进 output/）；产品默认运行去掉所有数据根覆盖。变量名按大写比较（Windows 不分大小写）。
 */
export function hostEnvironment(roots: HostRoots): NodeJS.ProcessEnv {
  const replaced =
    roots.l === null ? DATA_ROOT_OVERRIDES : [...DATA_ROOT_OVERRIDES, "LOCALAPPDATA"];
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !replaced.includes(key.toUpperCase())),
  );
  if (roots.l === null) return env;
  return {
    ...env,
    ATM_DATA_DIR: roots.l,
    ATM3_DATA_DIR: roots.n,
    LOCALAPPDATA: join(dirname(roots.n), "LocalAppData"),
  };
}

/** 注入的两个 WebView2 变量，生产宿主必须在建任何进程前清掉。 */
export const DECOY_VARIABLES = [
  "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
  "WEBVIEW2_USER_DATA_FOLDER",
] as const;

/**
 * 宿主环境之外故意塞 WebView2 的调试参数和另一个用户数据目录。安装半要把它交给 `atm-setup install`：
 * 事务 START 拉起的宿主继承 setup 的环境，productionChecks 之后只是直接用它（W8 关口 peer r15 P2-01）。
 */
export function decoyEnvironment(
  label: "portable" | "installed",
  roots: HostRoots,
): { env: NodeJS.ProcessEnv; decoy: string } {
  const decoy = join(outputRoot, `${label}-webview2-decoy`);
  return {
    env: {
      ...hostEnvironment(roots),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=0",
      WEBVIEW2_USER_DATA_FOLDER: decoy,
    },
    decoy,
  };
}

/** host.log 里这个宿主进程记下的「清掉了哪些变量」（只有名字）。 */
export function scrubbedVariables(log: string, pid: number): string[] {
  const line = log
    .split(/\r?\n/u)
    .find((entry) => entry.includes(` pid=${pid} scrubbed from the environment: `));
  return line ? line.split("scrubbed from the environment: ")[1]!.split(", ") : [];
}

/**
 * 生产二进制的运行检查。宿主已在运行（安装事务 START 拉起的）就直接用；否则后台启动。
 * 两种情况宿主的环境里都带着 decoyEnvironment 的诱饵：生产宿主必须在建任何进程前把它们
 * 清掉，于是既不会出现调试端口，也不会在那个目录里写东西。host.log 里宿主自己记下清掉的
 * 变量名，证明诱饵确实送到了被测的宿主。
 */
export async function productionChecks(
  label: "portable" | "installed",
  executable: string,
  roots: HostRoots,
): Promise<{ child: ChildProcess | null; runtime: Runtime; hostPid: number }> {
  const { env, decoy } = decoyEnvironment(label, roots);
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
  const scrubbed = scrubbedVariables(
    await readFile(join(roots.n, "logs", "host.log"), "utf8").catch(() => ""),
    hostRecord.pid,
  );
  check(
    `${label}：注入的 WebView2 变量送到了宿主（宿主记下已清掉）`,
    DECOY_VARIABLES.every((name) => scrubbed.includes(name)),
    `pid ${hostRecord.pid}: [${scrubbed.join(", ")}]`,
  );
  check(`${label}：后台启动不建窗口`, !appWindowVisible(hostRecord.pid), String(hostRecord.pid));
  run(executable, [], env);
  const shown = await waitUntil(
    async () => (appWindowVisible(hostRecord.pid) ? true : null),
    20_000,
  );
  check(`${label}：SHOW 后宿主窗口可见`, shown, String(hostRecord.pid));
  // 测试拉起的宿主带 ATM_BACKGROUND_WINDOW=1（scripts/test-windows.ts）：窗口在，但不抢正在用电脑的人的焦点。
  check(
    `${label}：测试里 SHOW 不激活窗口、不把它带到前台`,
    !activated(hostRecord.pid),
    String(hostRecord.pid),
  );
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

/** 一半的报告；`binaries` 是这一半实际运行的那份 exe 的哈希（候选绑定 L6）。 */
export async function writeSmokeReport(
  label: string,
  dataDir: string,
  from: number,
  binaries: BinarySet,
): Promise<void> {
  const own = checks.slice(from);
  await writeFile(
    join(root, "output", `${label}-smoke-report.json`),
    `${JSON.stringify(
      {
        passed: own.every((entry) => entry.passed),
        completedAt: new Date().toISOString(),
        dataDir,
        binaries,
        checks: own,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

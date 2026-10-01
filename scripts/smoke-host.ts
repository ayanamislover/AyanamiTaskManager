/**
 * 手动烟测共用的原生烟测宿主驱动（window / history / blur / login-startup / bridge-memory）。
 *
 * 做法与 packaged-smoke 一致：package-native --smoke 产出的版本目录（带 portable 标记）就地运行，
 * ATM_DATA_DIR 指到 output/ 下的沙箱；只有 smoke 构建的宿主给 WebView2 开 CDP 端口，
 * 端口从 <数据根>\webview\EBWebView\DevToolsActivePort 读，从不猜。
 *
 * 这里有两条硬约束，凡是用它的脚本都继承：
 *   - 数据根只能在仓库 output/ 下，绝不碰真实安装与真实数据根。
 *   - 结束进程只按自己拉起的宿主 PID 结束进程树，从不按镜像名。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { applyRunRestore, loginItemRestorePlan, readRunEntries } from "./login-item-guard.js";

export type SmokeRuntime = {
  endpoint: string;
  token: string;
  pid: number;
  instanceId: string;
  version: string;
};

export type SmokeHost = {
  child: ChildProcess;
  pid: number;
  stderr: string[];
  executable: string;
  dataDir: string;
  env: NodeJS.ProcessEnv;
};

export type SmokeRenderer = { browser: Browser; page: Page; port: number };

export const repoRoot = process.cwd();
export const outputRoot = join(repoRoot, "output");

export const sourceVersion = (
  JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string }
).version;

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

/** 有界轮询：read 返回非 null 即成功；超时抛出最后一次的错误或超时说明。 */
export async function waitUntil<T>(
  read: () => Promise<T | null>,
  timeoutMs = 30_000,
  label = "条件",
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value !== null) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  const reason = lastError instanceof Error ? `；最后一次错误：${lastError.message}` : "";
  throw new Error(`等待${label}超时（${timeoutMs}ms）${reason}`);
}

/** 被测宿主：默认是 smoke 构建的便携版本目录；ATM_PACKAGED_EXE 可改指另一份 smoke 构建。 */
export function smokeExecutable(): string {
  const executable = resolve(
    process.env.ATM_PACKAGED_EXE ??
      join(outputRoot, "package-smoke", `app-${sourceVersion}`, "AyanamiTaskManager.exe"),
  );
  if (!existsSync(executable))
    throw new Error(
      `找不到烟测宿主：${executable}；先跑 pnpm exec tsx scripts/package-native.ts --smoke output/package-smoke`,
    );
  if (!existsSync(join(dirname(executable), "portable")))
    throw new Error(`烟测宿主需要版本目录里的 portable 标记：${dirname(executable)}`);
  return executable;
}

const insideDirectory = (parent: string, candidate: string) => {
  const path = relative(parent.toLowerCase(), candidate.toLowerCase());
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
};

/** 已存在的路径按真实路径判断，防 junction 把 output/ 下的目录接到别处。 */
const realPath = (path: string) => {
  let probe = path;
  const tail: string[] = [];
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return path;
    tail.unshift(probe.slice(parent.length).replace(/^[\\/]/u, ""));
    probe = parent;
  }
  return join(realpathSync.native(probe), ...tail);
};

/** 真实安装与真实数据根：任何烟测都不许把数据根放到这里，也不许放到它们里面。 */
export function realInstallRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const local = env.LOCALAPPDATA;
  if (!local) return [];
  return [join(local, "AyanamiTaskManager"), join(local, "AyanamiTaskManagerDesktop")].map((path) =>
    resolve(path),
  );
}

/**
 * 数据根必须是仓库 output/ 下的子目录，且不能是（或落进）真实数据根与真实安装。
 * 返回规范化后的绝对路径。
 */
export function assertSandboxDataDir(
  dataDir: string,
  options: { outputRoot?: string; realRoots?: string[] } = {},
): string {
  const resolved = resolve(dataDir);
  const sandboxRoot = resolve(options.outputRoot ?? outputRoot);
  const realRoots = options.realRoots ?? realInstallRoots();
  const refuseReal = (candidate: string) => {
    for (const real of realRoots)
      if (candidate.toLowerCase() === real.toLowerCase() || insideDirectory(real, candidate))
        throw new Error(`拒绝在真实数据根/安装目录上运行烟测：${resolved}`);
  };
  // 先按字面拒：真实数据根本身连 realpath 都不去碰。
  refuseReal(resolved);
  if (!insideDirectory(sandboxRoot, resolved))
    throw new Error(`烟测数据根必须在 ${sandboxRoot} 之下：${resolved}`);
  // 再按真实路径拒：output/ 下的 junction 不能把数据根接到别处。
  const actual = realPath(resolved);
  refuseReal(actual);
  if (!insideDirectory(realPath(sandboxRoot), actual))
    throw new Error(`烟测数据根必须在 ${sandboxRoot} 之下（真实路径 ${actual}）：${resolved}`);
  return resolved;
}

/**
 * 宿主进程的环境。数据根显式给；继承来的数据根别名一律去掉。
 *
 * WebView2 在合成 USERPROFILE 下起不来，宿主保留真实 profile；core 与 stdio 桥这些 Node 子进程
 * 经 smoke 构建认的 ATM_SMOKE_CORE_USERPROFILE 拿合成 home，APPDATA / LOCALAPPDATA 也指进沙箱——
 * 于是界面上读 Agent 集成状态时，读到的是沙箱里的空配置，不是这台机器上真实的 Agent 配置。
 */
export function smokeHostEnvironment(dataDir: string, home: string): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !["ATM_DATA_DIR", "AYANAMI_TASK_DATA_DIR"].includes(entry[0]),
    ),
  );
  return {
    ...inherited,
    ATM_DATA_DIR: dataDir,
    APPDATA: join(home, "Roaming"),
    LOCALAPPDATA: join(home, "Local"),
    ATM_SMOKE_CORE_USERPROFILE: home,
  };
}

/**
 * 准备一个沙箱：数据根与合成 home 都在 output/ 下，名字固定（不带时间戳与版本号）。
 * fresh 时先清空数据根；合成 home 每次清掉重建，清不掉（输入法助手还攥着句柄）就沿用。
 */
export async function prepareSandbox(
  name: string,
  options: { dataDir?: string; fresh?: boolean } = {},
): Promise<{ dataDir: string; home: string; env: NodeJS.ProcessEnv }> {
  const dataDir = assertSandboxDataDir(options.dataDir ?? join(outputRoot, `${name}-data`));
  const home = assertSandboxDataDir(join(outputRoot, `${name}-home`));
  if (options.fresh ?? true) await rm(dataDir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined);
  await mkdir(dataDir, { recursive: true });
  await mkdir(join(home, "Roaming"), { recursive: true });
  await mkdir(join(home, "Local"), { recursive: true });
  return { dataDir, home, env: smokeHostEnvironment(dataDir, home) };
}

export const devToolsPortFile = (dataDir: string) =>
  join(dataDir, "webview", "EBWebView", "DevToolsActivePort");
export const runtimeFile = (dataDir: string) => join(dataDir, "runtime", "daemon.json");

export function startSmokeHost(input: {
  executable: string;
  dataDir: string;
  env: NodeJS.ProcessEnv;
  args?: string[];
}): SmokeHost {
  rmSync(devToolsPortFile(input.dataDir), { force: true });
  const child = spawn(input.executable, input.args ?? ["--background"], {
    cwd: repoRoot,
    env: input.env,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (child.pid === undefined) throw new Error(`烟测宿主没能启动：${input.executable}`);
  const stderr: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr.push(chunk.toString("utf8"));
    if (stderr.length > 20) stderr.shift();
  });
  return {
    child,
    pid: child.pid,
    stderr,
    executable: input.executable,
    dataDir: input.dataDir,
    env: input.env,
  };
}

export type Check = { name: string; passed: boolean; detail?: string };

/**
 * 断言记录：每条都进报告，失败即抛（与 packaged-smoke 的 check 同义）。
 * soft 只给验红用的临时副本打开：一次跑完、看哪些断言变红，而不是停在第一条。
 */
export class CheckLog {
  readonly checks: Check[] = [];
  soft = false;

  check(name: string, condition: unknown, detail?: string): asserts condition {
    if (!this.record(name, condition, detail) && !this.soft)
      throw new Error(`${name}：${detail ?? "未通过"}`);
  }

  /** 只记不抛：收尾阶段用，免得盖住前面真正的失败；报告的 passed 照样算它。 */
  record(name: string, condition: unknown, detail?: string): boolean {
    const passed = Boolean(condition);
    this.checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) });
    return passed;
  }

  /** 有界轮询直到 accept 成立；超时按最后一次读到的值记失败。返回最后一次的值。 */
  async eventually<T>(
    name: string,
    read: () => Promise<T>,
    accept: (value: T) => boolean,
    timeoutMs = 10_000,
    intervalMs = 100,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: T | undefined;
    let lastError: unknown;
    for (;;) {
      try {
        last = await read();
        lastError = undefined;
        if (accept(last)) {
          this.check(name, true);
          return last;
        }
      } catch (error) {
        lastError = error;
      }
      if (Date.now() >= deadline) break;
      await delay(intervalMs);
    }
    const detail =
      lastError instanceof Error ? lastError.message : `最后一次读到：${JSON.stringify(last)}`;
    this.check(name, false, detail);
    return last as T;
  }

  get failed(): Check[] {
    return this.checks.filter((entry) => !entry.passed);
  }
}

export async function readRuntime(dataDir: string): Promise<SmokeRuntime | null> {
  if (!existsSync(runtimeFile(dataDir))) return null;
  const runtime = JSON.parse(await readFile(runtimeFile(dataDir), "utf8")) as SmokeRuntime;
  const response = await fetch(`${runtime.endpoint}/api/v1/system/status`, {
    headers: { authorization: `Bearer ${runtime.token}` },
  });
  return response.ok ? runtime : null;
}

export async function waitForRuntime(host: SmokeHost, timeoutMs = 30_000): Promise<SmokeRuntime> {
  return waitUntil(
    async () => {
      if (host.child.exitCode !== null)
        throw new Error(`宿主提前退出（${host.child.exitCode}）：${host.stderr.join("")}`);
      return readRuntime(host.dataDir);
    },
    timeoutMs,
    "服务健康",
  );
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return Promise.race([
    new Promise<number | null>((resolveExit) => child.once("exit", (code) => resolveExit(code))),
    delay(timeoutMs).then(() => null),
  ]);
}

/** 用户再点一次入口：第二实例把 SHOW 交给正在运行的宿主后退出。 */
export async function requestShow(host: SmokeHost): Promise<void> {
  const show = spawn(host.executable, [], { cwd: repoRoot, env: host.env, stdio: "ignore" });
  if ((await waitForExit(show, 10_000)) === null) {
    show.kill();
    throw new Error("SHOW 请求没有在 10 秒内送达");
  }
}

/** DevToolsActivePort 第一行就是端口；文件还没写或写到一半时返回 null。 */
export async function readDevToolsPort(dataDir: string): Promise<number | null> {
  if (!existsSync(devToolsPortFile(dataDir))) return null;
  const value = Number((await readFile(devToolsPortFile(dataDir), "utf8")).split(/\r?\n/u)[0]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * 经 CDP 连上宿主的 WebView。窗口关掉再开会换一个 WebView2 浏览器进程和端口，
 * 所以每次都重新读端口文件，连不上就下一轮再读。
 */
export async function connectRenderer(host: SmokeHost, timeoutMs = 30_000): Promise<SmokeRenderer> {
  return waitUntil(
    async () => {
      const port = await readDevToolsPort(host.dataDir);
      if (port === null) return null;
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const page = browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => !candidate.url().startsWith("devtools:"));
      if (!page) {
        await browser.close().catch(() => undefined);
        return null;
      }
      return { browser, page, port };
    },
    timeoutMs,
    "WebView 的 CDP 连接",
    250,
  );
}

/**
 * 像用户一样打开项目：点侧栏「活动项目」里的那一项。刚经 renderer 建的项目要等界面下一次
 * 刷新列表才出现（query-policy.ts 每 30 秒一轮），所以最多等 40 秒。
 * 不改 hash 再 reload：宿主只放行入口文档本身的导航，带 hash 的 reload 会被拦下。
 */
export async function openProjectFromSidebar(page: Page, name: string): Promise<void> {
  await page
    .getByRole("navigation", { name: "活动项目" })
    .getByRole("button", { name, exact: true })
    .click({ timeout: 40_000 });
}

/** 只结束自己拉起的那个宿主的进程树（core、WebView2 都在树里），从不按镜像名。 */
export function killProcessTree(pid: number): void {
  spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
}

/**
 * 干净退出：smoke 构建认 --smoke-quit（第二实例把 SmokeQuit 交给主实例）。
 * 返回是否干净退出；超时就按进程树强制结束并返回 false。
 */
export async function stopSmokeHost(host: SmokeHost, timeoutMs = 15_000): Promise<boolean> {
  if (host.child.exitCode !== null) return true;
  const request = spawn(host.executable, ["--smoke-quit"], {
    cwd: repoRoot,
    env: host.env,
    windowsHide: true,
    stdio: "ignore",
  });
  await waitForExit(request, 5_000);
  if ((await waitForExit(host.child, timeoutMs)) !== null) return true;
  killProcessTree(host.pid);
  await waitForExit(host.child, 5_000);
  return false;
}

/**
 * 宿主的自启动开关写的是 HKCU Run 里与真实安装共用的那个值。界面上的设置一旦碰到它，
 * 就会把用户真实的登记改指到烟测宿主。跑之前记下、跑完把本应用相关的登记原样放回。
 */
export async function withLoginItemsRestored<T>(run: () => Promise<T>): Promise<T> {
  const before = readRunEntries();
  try {
    return await run();
  } finally {
    applyRunRestore(loginItemRestorePlan(before, readRunEntries()));
  }
}

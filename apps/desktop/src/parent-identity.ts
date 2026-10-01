import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * core 只接受真正的宿主当父进程（ATM-T-0520）。
 *
 * 用户权限只经 host-control 管道进来，而这条管道就是 core 的 stdin/stdout。任何同用户进程都能
 * 自己拉起 atm-core.exe 当它的父进程——如果 core 不看父进程是谁，那就等于新开了一个「不经界面
 * 就能替用户做决定」的正常调用捷径。所以握手前先查：父进程映像必须是本版本目录里的宿主 exe。
 *
 * 伪造父进程属性、注入宿主属于安全模型的非目标（同用户蓄意攻击，见 docs/security-model.md）；
 * 这里挡的是「按文档办事的 Agent 顺手拉起 core」这条路。
 *
 * 查询方式与 apps/daemon/src/process-identity.ts 同一口径：有宿主时用本版本目录里的宿主
 * `--process-identity <pid>`（GetProcessTimes + QueryFullProcessImageNameW，宿主 identity.rs），
 * 宿主起不来才退回 PowerShell 的 Get-Process 标量；都不走 WMI/CIM。宿主二进制和 core 的 bundle
 * 在同一个版本目录里，信它不比信 core 自己多信任什么；而 PowerShell 每次要约 190 ms，
 * 这次查询挡在握手前面，冷启动每次都等它。
 */

export type ParentIdentity = { path: string; startedAtMs: number };

const QUERY_TIMEOUT_MS = 3000;
const MAX_OUTPUT_BYTES = 4096;

function powershellPath(): string | null {
  if (process.platform !== "win32" || !process.env.SystemRoot) return null;
  return join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function parentQueryArguments(pid: number): string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `$ErrorActionPreference='Stop'; try { $p=Get-Process -Id ${pid} -ErrorAction Stop; [Console]::WriteLine($p.Path); [Console]::WriteLine(([DateTimeOffset]$p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds().ToString([Globalization.CultureInfo]::InvariantCulture)) } catch { exit 1 }`,
  ];
}

export function parseParentIdentity(stdout: string): ParentIdentity | null {
  const [path, milliseconds] = stdout.trim().split(/\r?\n/u);
  if (!path || path.length > 1024 || !milliseconds || !/^\d{1,16}$/u.test(milliseconds))
    return null;
  const startedAtMs = Number(milliseconds);
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs <= 0) return null;
  return { path, startedAtMs };
}

/** 宿主 `--process-identity` 的输出：ticks、Unix 毫秒、映像路径各一行。 */
export function parseHelperIdentity(stdout: string): ParentIdentity | null {
  const [ticks, milliseconds, path] = stdout.trim().split(/\r?\n/u);
  if (!ticks || !/^\d{17,19}$/u.test(ticks) || path === undefined) return null;
  return parseParentIdentity(`${path}\n${milliseconds ?? ""}`);
}

type ParentQuery = {
  command: string;
  args: string[];
  parse: (stdout: string) => ParentIdentity | null;
};

/**
 * 查不到、拒绝访问、超时一律返回 null；调用方把 null 当作拒绝。helper 是本版本目录里的宿主，
 * 它给不出答案（起不来、不认这个参数、查不到）就换 PowerShell 再问一次：两边读的是同一份
 * 系统记录，换一条路问不会让答案更宽松，只是慢一些。
 */
export function queryParentIdentity(
  pid: number,
  helper: string | null = null,
): Promise<ParentIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(null);
  const queries: ParentQuery[] = [];
  if (helper)
    queries.push({
      command: helper,
      args: ["--process-identity", String(pid)],
      parse: parseHelperIdentity,
    });
  const shell = powershellPath();
  if (shell)
    queries.push({ command: shell, args: parentQueryArguments(pid), parse: parseParentIdentity });
  return runParentQuery(queries);
}

function runParentQuery(queries: readonly ParentQuery[]): Promise<ParentIdentity | null> {
  const [query, ...fallbacks] = queries;
  if (!query) return Promise.resolve(null);
  return new Promise((done) => {
    let child;
    try {
      child = spawn(query.command, query.args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      done(runParentQuery(fallbacks));
      return;
    }
    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => child.kill(), QUERY_TIMEOUT_MS);
    const finish = (identity: ParentIdentity | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(identity ?? runParentQuery(fallbacks));
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk;
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? query.parse(stdout) : null));
  });
}

/** 经 junction（`<dataDir>\current`）启动时进程报告的是链接路径；两边都先解析到真实路径再比。 */
function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    let real = resolve(value);
    try {
      real = realpathSync.native(real);
    } catch {
      // 不存在就按字面比：映像已被删掉的父进程不可能是可信宿主。
    }
    return real.replace(/[\\/]+$/u, "").toLowerCase();
  };
  return normalize(left) === normalize(right);
}

/**
 * 父进程是不是这个版本目录里的宿主。appDir 由 core 从自身 bundle 位置推导，不信握手自报。
 * 父进程必须比自己先启动（PID 复用时，新进程的启动时间会晚于 core）。
 */
export function isTrustedHostParent(
  parent: ParentIdentity | null,
  expectedHostPath: string,
  selfStartedAtMs: number,
): boolean {
  if (!parent) return false;
  if (!samePath(parent.path, expectedHostPath)) return false;
  return parent.startedAtMs <= selfStartedAtMs;
}

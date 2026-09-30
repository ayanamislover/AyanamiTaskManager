import { spawn } from "node:child_process";
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
 * 查询方式与 apps/daemon/src/process-identity.ts 同一口径：Get-Process 标量，不走 WMI/CIM。
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

/** 查不到、拒绝访问、超时一律返回 null；调用方把 null 当作拒绝。 */
export function queryParentIdentity(pid: number): Promise<ParentIdentity | null> {
  const shell = powershellPath();
  if (!shell || !Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(null);
  return new Promise((done) => {
    let child;
    try {
      child = spawn(shell, parentQueryArguments(pid), {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      done(null);
      return;
    }
    let stdout = "";
    const timer = setTimeout(() => child.kill(), QUERY_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk;
    });
    const finish = (code: number | null) => {
      clearTimeout(timer);
      done(code === 0 ? parseParentIdentity(stdout) : null);
    };
    child.on("error", () => finish(null));
    child.on("close", finish);
  });
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    resolve(value)
      .replace(/[\\/]+$/u, "")
      .toLowerCase();
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

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

/** `process.kill(pid, 0)` 只探测不发信号；EPERM 说明进程在但不归我们管，也算活着。 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

type RunResult =
  | { ok: true; stdout: string }
  | { ok: false; exitCode: number | null; text: string };

function run(command: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: 15_000, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (!error) return resolve({ ok: true, stdout: String(stdout).trim() });
        // 进程跑完但退出码非 0 时 error.code 是数字；没起来（ENOENT）或超时被杀时不是。
        const code = (error as { code?: unknown }).code;
        const detail = String(stderr).trim() || String(stdout).trim() || error.message;
        resolve({ ok: false, exitCode: typeof code === "number" ? code : null, text: detail });
      },
    );
  });
}

/** Windows FILETIME：1601 年起的 100ns 计数，十进制整数。 */
const FILETIME_PATTERN = /^[1-9]\d{0,19}$/u;

/** PowerShell 打印的 `StartTime.ToFileTimeUtc()`：进程创建时刻的 FILETIME 原值；看不懂返回 null。 */
export function parseFileTime(stdout: string): string | null {
  const value = stdout.trim();
  return FILETIME_PATTERN.test(value) ? value : null;
}

/**
 * `/proc/<pid>/stat` 的第 22 字段 starttime（开机后的时钟滴答数，进程一生不变）。
 * 第 2 字段 comm 在括号里且可能含空格和括号，所以从最后一个 `)` 之后数：那里是第 3 字段。
 */
export function parseProcStatStartTime(stat: string): string | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/u);
  const value = fields[22 - 3];
  return value !== undefined && /^\d+$/u.test(value) ? value : null;
}

/** Linux：开机 ID + starttime。跨重启 starttime 会重新计数，带上 boot_id 才不会把重启前后的同号进程认成一个。 */
export function linuxProcessIdentity(
  pid: number,
  readText: (path: string) => string = (path) => readFileSync(path, "utf8"),
): string | null {
  try {
    const start = parseProcStatStartTime(readText(`/proc/${pid}/stat`));
    const boot = readText("/proc/sys/kernel/random/boot_id").trim();
    if (start === null || !/^[0-9a-f-]{16,64}$/u.test(boot)) return null;
    return `linux:${boot}:${start}`;
  } catch {
    return null;
  }
}

/**
 * 进程的出生标识：同一个进程任何时候读到的都完全相同，PID 被复用后的新进程一定不同。调用方只做精确相等比较。
 * - Windows：`(Get-Process -Id <pid>).StartTime.ToFileTimeUtc()`，即 GetProcessTimes 的创建时刻 FILETIME
 *   原值（100ns 整数）。.NET 的本地时间往返带 DST 歧义标记，转回 UTC 是精确的；实测两次读取逐位相同。
 * - Linux：`/proc/<pid>/stat` 的 starttime 原值 + 开机 ID。
 * - 其它平台（macOS 等）拿不到稳定且足够精细的出生标识（`ps lstart` 只有秒级，排除不了同秒复用）：返回 null，
 *   身份一律未知，不接管也不结束。
 * 查不到（进程不在、权限不足、探测超时）同样返回 null。
 */
export async function defaultProcessIdentity(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === "linux") return linuxProcessIdentity(pid);
  if (platform !== "win32") return null;
  const result = await run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc()`,
  ]);
  const filetime = result.ok ? parseFileTime(result.stdout) : null;
  return filetime === null ? null : `win32:${filetime}`;
}

/**
 * 结束进程树的结果：`killed` = 系统接受了强制结束；`gone` = 进程本来就不在了；
 * `failed` = 没结束掉（权限不足、taskkill 起不来或超时……），`reason` 给人看。
 */
export type KillResult = { kind: "killed" } | { kind: "gone" } | { kind: "failed"; reason: string };

/** taskkill 找不到进程时的退出码（实测：`ERROR: The process "…" not found.`，exit 128；文案随系统语言变，只认退出码）。 */
export const TASKKILL_NOT_FOUND_EXIT_CODE = 128;

function clip(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= 200 ? flat : `${flat.slice(0, 199)}…`;
}

/**
 * 结束整棵进程树：Windows 用 `taskkill /PID <pid> /T /F`（参数数组）；
 * 其它平台向进程组发 SIGKILL（子进程是 detached 起的，自成一组），与 /F 一样不可忽略。
 * 调用方必须先确认这个 PID 仍是自己的会话进程：这里只管结束，不管身份。
 */
export async function killProcessTree(pid: number): Promise<KillResult> {
  if (!Number.isInteger(pid) || pid <= 0) return { kind: "gone" };
  if (process.platform === "win32") {
    const result = await run("taskkill", ["/PID", String(pid), "/T", "/F"]);
    if (result.ok) return { kind: "killed" };
    if (result.exitCode === TASKKILL_NOT_FOUND_EXIT_CODE) return { kind: "gone" };
    const exit =
      result.exitCode === null ? "taskkill 没有正常运行" : `taskkill 退出码 ${result.exitCode}`;
    return { kind: "failed", reason: clip(`${exit}：${result.text}`) };
  }
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGKILL");
      return { kind: "killed" };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") continue; // 没有这个进程组：再按单个进程试一次。
      return { kind: "failed", reason: clip(`发送 SIGKILL 失败（${code ?? "未知错误"}）`) };
    }
  }
  return { kind: "gone" };
}

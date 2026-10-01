import { execFile } from "node:child_process";

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

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: 15_000, windowsHide: true, encoding: "utf8", ...(env ? { env } : {}) },
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

/**
 * 进程创建时间，用来识别 PID 复用（Windows 上 PID 很快会被新进程拿去用）。
 * Windows 用 PowerShell 的 Get-Process（100ns 精度），其它平台用 `ps -o lstart=`（秒级）；拿不到返回 null。
 */
export async function defaultProcessStartTime(pid: number): Promise<Date | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const result =
    process.platform === "win32"
      ? await run("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
        ])
      : await run("ps", ["-o", "lstart=", "-p", String(pid)], { ...process.env, LC_ALL: "C" });
  if (!result.ok || !result.stdout) return null;
  const at = new Date(result.stdout);
  return Number.isNaN(at.getTime()) ? null : at;
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

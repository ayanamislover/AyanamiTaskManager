import { execFile } from "node:child_process";

/**
 * 所有 git 调用都从这里走，而且都是异步的。
 *
 * 以前用的是 execFileSync / spawnSync：本仓实测 scanWorkItemChanges 1626ms、
 * scanProjectMetrics 1289ms、inspectGitContext 418ms。同步子进程期间 daemon 的
 * 事件循环整个停住，这段时间里任何请求都排不上号——点开任务详情慢、改个任务状态要等，
 * 慢的都不是那件事本身，是它排在一串 git 后面。
 *
 * 异步之后 git 仍然要跑这么久，但它跑的时候 daemon 照常应答别的请求。
 */
export type GitCommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  signal?: string | null;
  error?: Error & { code?: string };
};

export type GitCommandRunner = (
  args: string[],
  cwd: string,
  timeoutMs: number,
) => Promise<GitCommandResult>;

export function defaultGitCommandRunner(
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd,
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ status: 0, stdout, stderr, signal: null });
          return;
        }
        // execFile 把退出码放在 error.code（数字），超时和被杀放在 signal；
        // 找不到 git 时 code 是 'ENOENT' 这样的字符串，那种情况没有退出码。
        const typed = error as Error & {
          code?: number | string;
          signal?: string | null;
        };
        resolve({
          status: typeof typed.code === "number" ? typed.code : null,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          signal: typed.signal ?? null,
          error: typed as Error & { code?: string },
        });
      },
    );
  });
}

const METRICS_TIMEOUT_MS = 30_000;

/** 统计扫描用的调用：失败即抛，错误信息带上命令和 stderr，别只留一句 Command failed。 */
export async function runGit(
  directory: string,
  args: string[],
  runner: GitCommandRunner = defaultGitCommandRunner,
): Promise<string> {
  const result = await runner(args, directory, METRICS_TIMEOUT_MS);
  if (result.status !== 0) {
    const reason = result.error?.message ?? result.stderr.trim();
    throw new Error(
      `GIT_METRICS_FAILED: git ${args.join(" ")} (${result.status}) ${reason}`.trim(),
    );
  }
  return result.stdout.trim();
}

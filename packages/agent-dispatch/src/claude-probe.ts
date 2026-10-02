import { execFile } from "node:child_process";
import { dispatchChildEnv, launchCommand } from "./launch.js";

/** `claude auth status` 的结论：null 表示没探出来（超时、输出看不懂、命令不支持），不当作未登录。 */
export type ClaudeAuthState = { loggedIn: boolean | null; authMethod?: string };

/** 登录状态缓存多久。用户在终端里登录/登出后，最迟这么久状态页就会跟上；派单前另有强制重探。 */
export const CLAUDE_AUTH_CACHE_MS = 5 * 60_000;
export const CLAUDE_AUTH_PROBE_TIMEOUT_MS = 5_000;
const VERSION_PROBE_TIMEOUT_MS = 10_000;

type ProbeOutput = { stdout: string; timedOut: boolean; failed: boolean };

/**
 * 解析 `claude auth status --json`。实测输出（未登录时退出码 1，stdout 照样是 JSON）：
 * `{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}`。
 */
export function parseAuthStatus(stdout: string): ClaudeAuthState {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) return { loggedIn: null };
  try {
    const value = JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof value.loggedIn !== "boolean") return { loggedIn: null };
    const method = typeof value.authMethod === "string" ? value.authMethod.slice(0, 64) : "";
    return { loggedIn: value.loggedIn, ...(method ? { authMethod: method } : {}) };
  } catch {
    return { loggedIn: null };
  }
}

/**
 * 对 claude 命令行做的只读探测：`--version`（按路径永久缓存）与 `auth status`（缓存 5 分钟）。
 * 子进程环境同样走 {@link dispatchChildEnv}，否则在 Claude 会话里启动的 ATM 会探到宿主会话的登录态。
 */
export class ClaudeProbe {
  readonly #baseEnv: NodeJS.ProcessEnv;
  readonly #now: () => Date;
  readonly #authTimeoutMs: number;
  #version: { path: string; value: Promise<string | null> } | null = null;
  #auth: { path: string; at: number; value: Promise<ClaudeAuthState>; settled: boolean } | null =
    null;

  constructor(options: { baseEnv: NodeJS.ProcessEnv; now: () => Date; authTimeoutMs?: number }) {
    this.#baseEnv = options.baseEnv;
    this.#now = options.now;
    this.#authTimeoutMs = options.authTimeoutMs ?? CLAUDE_AUTH_PROBE_TIMEOUT_MS;
  }

  version(path: string): Promise<string | null> {
    if (this.#version?.path === path) return this.#version.value;
    const value = this.#run(path, ["--version"], VERSION_PROBE_TIMEOUT_MS).then((output) => {
      if (output.failed) return null;
      const line = output.stdout.trim().split(/\r?\n/u)[0]!.trim();
      return line ? line.slice(0, 80) : null;
    });
    this.#version = { path, value };
    return value;
  }

  /**
   * 登录状态。`fromCache` 表示用的是之前探好的结果（而不是这次调用新探或正在进行中的那次），
   * 调用方据此决定「缓存说未登录」时要不要强制重探。
   */
  async auth(
    path: string,
    options: { force?: boolean } = {},
  ): Promise<{ state: ClaudeAuthState; fromCache: boolean }> {
    const cached = this.#auth;
    const fresh =
      cached !== null &&
      cached.path === path &&
      this.#now().getTime() - cached.at < CLAUDE_AUTH_CACHE_MS;
    if (fresh && !options.force) return { state: await cached.value, fromCache: cached.settled };
    const entry = {
      path,
      at: this.#now().getTime(),
      settled: false,
      value: this.#run(path, ["auth", "status", "--json"], this.#authTimeoutMs).then((output) =>
        output.timedOut ? { loggedIn: null } : parseAuthStatus(output.stdout),
      ),
    };
    void entry.value.finally(() => {
      entry.settled = true;
    });
    this.#auth = entry;
    return { state: await entry.value, fromCache: false };
  }

  /** 会话因为鉴权失败结束时调用：下次查状态重新探，而不是继续报「已登录」。 */
  invalidateAuth(): void {
    this.#auth = null;
  }

  #run(path: string, args: string[], timeoutMs: number): Promise<ProbeOutput> {
    return new Promise((resolve) => {
      let command: ReturnType<typeof launchCommand>;
      try {
        command = launchCommand(path, args);
      } catch {
        resolve({ stdout: "", timedOut: false, failed: true });
        return;
      }
      execFile(
        command.command,
        command.args,
        {
          timeout: timeoutMs,
          windowsHide: true,
          encoding: "utf8",
          env: dispatchChildEnv(this.#baseEnv, "probe"),
          ...(command.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        },
        (error, stdout) => {
          // 未登录时 `auth status` 退出码是 1，stdout 仍然有效，所以非零退出不等于探测失败。
          const timedOut = Boolean(error && (error as { killed?: boolean }).killed);
          resolve({ stdout: String(stdout ?? ""), timedOut, failed: error !== null });
        },
      );
    });
  }
}

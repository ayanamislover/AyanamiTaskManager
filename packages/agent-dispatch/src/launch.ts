import { randomBytes } from "node:crypto";
import { extname } from "node:path";
import {
  DISPATCH_EFFORTS,
  DISPATCH_MODEL_PATTERN,
  DISPATCH_PERMISSION_MODES,
  type DispatchConfig,
} from "./config.js";
import { DispatchError } from "./errors.js";

/** 任务键会进命令行（`--name "ATM · <key>"`），入口处按这个格式校验。 */
export const DISPATCH_TASK_KEY_PATTERN = /^[A-Z][A-Z0-9]*-T-\d{4,}$/u;
/** 派单编号：毫秒时间的 base36 + 8 位随机 hex，按字典序大致就是时间序。 */
export const DISPATCH_RUN_PATTERN = /^[0-9a-z]{1,16}-[0-9a-f]{8}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function newRunId(now: Date): string {
  return `${now.getTime().toString(36)}-${randomBytes(4).toString("hex")}`;
}

export type ClaudeArgumentsInput = {
  sessionId: string;
  key: string;
  config: Pick<DispatchConfig, "permissionMode" | "model" | "effort">;
};

/**
 * `claude -p` 的参数数组。提示词不在这里：它从 stdin 写入，避免命令行长度上限与转义问题。
 * 每个值都是枚举或按白名单校验过的，所以即使经 cmd.exe 转发也没有可注入的字符。
 */
export function claudeArguments(input: ClaudeArgumentsInput): string[] {
  const { sessionId, key, config } = input;
  if (!DISPATCH_TASK_KEY_PATTERN.test(key))
    throw new DispatchError("DISPATCH_INVALID_ARGUMENT", `任务键格式不合法：${key}`);
  if (!UUID_PATTERN.test(sessionId))
    throw new DispatchError("DISPATCH_INVALID_ARGUMENT", "会话 ID 必须是小写 UUID");
  if (!(DISPATCH_PERMISSION_MODES as readonly string[]).includes(config.permissionMode))
    throw new DispatchError("DISPATCH_INVALID_ARGUMENT", "权限模式不合法");
  if (config.model !== null && !DISPATCH_MODEL_PATTERN.test(config.model))
    throw new DispatchError("DISPATCH_INVALID_ARGUMENT", "model 只能包含字母、数字与 ._-");
  if (config.effort !== null && !(DISPATCH_EFFORTS as readonly string[]).includes(config.effort))
    throw new DispatchError("DISPATCH_INVALID_ARGUMENT", "effort 不合法");
  return [
    "-p",
    "--permission-mode",
    config.permissionMode,
    "--output-format",
    "stream-json",
    "--verbose",
    "--session-id",
    sessionId,
    "--name",
    `ATM · ${key}`,
    ...(config.model === null ? [] : ["--model", config.model]),
    ...(config.effort === null ? [] : ["--effort", config.effort]),
  ];
}

export type LaunchCommand = {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
};

/** cmd.exe 在双引号里仍会展开 `%VAR%`、`!VAR!`，引号本身与换行也无法安全表示。 */
// eslint-disable-next-line no-control-regex
const CMD_UNSAFE = /["%!^\r\n\u0000]/u;

function cmdQuote(value: string): string {
  if (CMD_UNSAFE.test(value))
    throw new DispatchError(
      "DISPATCH_INVALID_ARGUMENT",
      "参数含 cmd.exe 无法安全转义的字符（引号、%、!、^ 或换行）",
    );
  return /^[A-Za-z0-9._:\\/=-]+$/u.test(value) ? value : `"${value}"`;
}

/**
 * 把「claude 路径 + 参数」变成可直接 spawn 的命令，不经 shell：
 * - `.js/.mjs/.cjs`：用当前 Node 运行（测试里的假 claude 就走这条）；
 * - Windows 上的 `.cmd/.bat`（npm 装法）：Node 不允许不经 shell 直接起批处理，
 *   这里显式 `cmd.exe /d /s /c "<整行>"`，每个参数都过 {@link cmdQuote}；
 * - 其余（官方安装器的 claude.exe、POSIX 的 claude）：直接起。
 */
export function launchCommand(
  claudePath: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  comspec: string | undefined = process.env.ComSpec,
): LaunchCommand {
  const extension = extname(claudePath).toLowerCase();
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs")
    return { command: process.execPath, args: [claudePath, ...args] };
  if (platform === "win32" && (extension === ".cmd" || extension === ".bat")) {
    const line = [claudePath, ...args].map(cmdQuote).join(" ");
    return {
      command: comspec || "cmd.exe",
      args: ["/d", "/s", "/c", `"${line}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { command: claudePath, args: [...args] };
}

/**
 * 从宿主环境继承时要去掉的变量：它们属于「当前这个 Claude 会话」或 ATM 的用户凭证，
 * 继承下去会把派单会话串到宿主会话上（或把不该给 Agent 的凭证交出去）。
 * 只在 ATM 本身是从某个 Claude 会话里启动时才会出现（开发、调试）；正常从开始菜单启动时一个都没有。
 * 用户配置类变量（ANTHROPIC_*、CLAUDE_CODE_USE_*、HTTPS_PROXY、DISABLE_* 等）一律保留。
 */
export const HOST_SESSION_ENV: Readonly<Record<string, string>> = Object.freeze({
  CLAUDECODE: "标记「已在 Claude Code 会话里」，子进程会按嵌套会话处理",
  CLAUDE_CODE_ENTRYPOINT: "宿主的入口类型，子会话会冒用宿主的入口身份",
  CLAUDE_CODE_SSE_PORT: "宿主会话连着的 IDE 扩展端口，子会话会去连宿主的 IDE",
  CLAUDE_CODE_SESSION_ID: "宿主会话 ID；派单会话用自己的 --session-id",
  CLAUDE_CODE_HOST_SESSION_ID: "Claude 桌面 App 给宿主会话的绑定 ID",
  CLAUDE_CODE_CHILD_SESSION: "标记「由某个宿主会话派生」，派单会话是独立会话",
  CLAUDE_CODE_MESSAGING_SOCKET: "宿主会话与桌面 App 之间的 IPC 管道",
  CLAUDE_CODE_MESSAGING_TOKEN: "上面那条 IPC 管道的令牌，属于宿主会话的密钥",
  CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH:
    "登录态由宿主经 SDK 刷新；派单会话没有宿主，只能用自己的登录态",
  CLAUDE_CODE_SESSION_ATTENDED: "宿主会话有人值守；派单会话无人值守",
  CLAUDE_CODE_EXECPATH: "宿主 claude 可执行文件的路径",
  CLAUDE_PID: "宿主 claude 进程的 PID",
  CLAUDE_AGENT_SDK_VERSION: "宿主经 Agent SDK 拉起；派单会话不是",
  CLAUDE_CODE_DESKTOP_APP_VERSION: "宿主嵌在 Claude 桌面 App 里；派单会话不是",
  CLAUDE_CODE_TERMINAL_MCP_TOOLS: "桌面 App 终端面板只提供给宿主会话的工具清单",
  CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL: "宿主界面能回答提问；无头会话没人回答，只会卡住",
  CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: "SDK 宿主的文件检查点协议，无头会话没有接收方",
  "SENTRY-TRACE": "宿主的链路追踪上下文，派单会话会被记到宿主的 trace 下",
  BAGGAGE: "同上（W3C baggage 追踪上下文）",
  AYANAMI_TASK_USER_TOKEN: "ATM 用户凭证：交给 Agent 会让 USER_ONLY 形同虚设",
});

const STRIPPED = new Set(Object.keys(HOST_SESSION_ENV).map((name) => name.toUpperCase()));

/** 派单子进程的环境：继承宿主环境，去掉 {@link HOST_SESSION_ENV}（Windows 上大小写不敏感），加上 ATM_DISPATCH_RUN。 */
export function dispatchChildEnv(base: NodeJS.ProcessEnv, run: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || STRIPPED.has(name.toUpperCase())) continue;
    if (name.toUpperCase() === "ATM_DISPATCH_RUN") continue;
    env[name] = value;
  }
  env.ATM_DISPATCH_RUN = run;
  return env;
}

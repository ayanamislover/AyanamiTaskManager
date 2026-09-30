import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { DispatchConfig } from "./config.js";

type MaybePromise<T> = T | Promise<T>;

/** 派单需要的项目信息。`paths` 按「主路径在前」排好，第一个就是会话的工作目录。 */
export type DispatchProject = { code: string; name: string; paths: string[] };

/** 派单需要的任务信息；领取字段用来判断任务是否已经有人在做。 */
export type DispatchTask = {
  key: string;
  title: string;
  status: string;
  description: string;
  claimedBySessionId: string | null;
  claimLeaseUntil: string | null;
};

/**
 * 宿主端口：派单只通过它读项目与任务，不依赖 application 包。
 * 找不到时返回 null；抛出的错误（例如数据库不可用）原样透传给调用方。
 */
export type DispatchHost = {
  getProject(code: string): MaybePromise<DispatchProject | null>;
  getTask(code: string, key: string): MaybePromise<DispatchTask | null>;
};

export type DispatchOrigin = "mobile" | "desktop";
export type DispatchState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** 会话结束时从日志末尾 `{"type":"result"}` 行摘出的摘要。 */
export type DispatchRunSummary = {
  numTurns: number | null;
  durationMs: number | null;
  totalCostUsd: number | null;
  /** result 文本，截断到 500 字。 */
  result: string;
};

export type DispatchRunView = {
  run: string;
  project: string;
  key: string;
  title: string;
  origin: DispatchOrigin;
  state: DispatchState;
  /** 固定并持久化的 Claude 会话 ID：事后可以 `claude -r <sessionId>` 接着对话。 */
  sessionId: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number | null;
  summary?: DispatchRunSummary;
  error?: string;
};

/** runs.json 里的一条：对外视图 + 只供本机跟踪进程用的字段。 */
export type DispatchRunRecord = DispatchRunView & {
  cwd: string;
  requestedBy?: string;
  pid?: number;
};

export type DispatchClaudeStatus = { found: boolean; path: string | null; version?: string };

export type DispatchStatus = DispatchConfig & {
  claude: DispatchClaudeStatus;
  runs: DispatchRunView[];
};

export type DispatchChangeEvent =
  | { type: "run"; run: DispatchRunView }
  | { type: "config"; config: DispatchConfig };

export type DispatchLogger = {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
};

export type DispatchSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export type EnqueueInput = {
  project: string;
  key: string;
  origin: DispatchOrigin;
  /** 谁发起的（例如手机设备名），只进历史与提示词的「来源」一行。 */
  requestedBy?: string;
};

export type AgentDispatcherOptions = {
  dataDir: string;
  host: DispatchHost;
  /** 定位 claude 可执行文件；默认 agent-config 的 findClaudeCodeCli()。 */
  resolveClaude?: () => string | null;
  /** 测试注入用；默认 node:child_process 的 spawn。 */
  spawnImpl?: DispatchSpawn;
  now?: () => Date;
  logger?: DispatchLogger;
  /** 重启后接管的会话（不是本进程的子进程）用轮询判断是否结束，默认 5 秒。 */
  pollIntervalMs?: number;
  /** 查询进程创建时间，用来识别 Windows PID 复用；拿不到返回 null。 */
  processStartTime?: (pid: number) => Promise<Date | null>;
  /** 子进程环境的来源，默认 process.env。 */
  baseEnv?: NodeJS.ProcessEnv;
};

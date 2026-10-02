import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { DispatchConfig } from "./config.js";
import type { KillResult } from "./process.js";

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
  /**
   * spawn 后立刻向 OS 查到的进程出生标识（Windows `win32:<FILETIME>`、Linux `linux:<boot_id>:<starttime>`）；
   * 查不到就没有这个字段（身份未知）。宿主重启后只有它与现查的标识逐字相同才接管这个 PID，
   * 见 process-identity.ts。旧版本存的 ISO 创建时间（processCreatedAt）读入时丢弃，按未知处理。
   */
  processIdentity?: string;
  /** 手机命令 ID（EnqueueInput.requestId）：请求账本丢失时据此重建「这条命令派过哪次」。 */
  requestId?: string;
};

export type DispatchClaudeStatus = {
  found: boolean;
  path: string | null;
  version?: string;
  /** `claude auth status` 的结论，缓存 5 分钟；null = 没探出来（超时、输出看不懂或没找到 claude）。 */
  loggedIn: boolean | null;
  /** 例如 `claude.ai`、`none`；探不出来时没有这个字段。 */
  authMethod?: string;
};

/** 派单请求账本的健康状况（不含任何密钥），见 request-ledger.ts。 */
export type DispatchLedgerStatus = {
  /**
   * 账本数据丢失过（文件损坏、条目不合法、被删）：这个时刻（含）之前发出的手机派单无法确认是否执行过，
   * 一律拒绝（DISPATCH_REQUEST_STATE_LOST），请用户在手机上重新交给 Claude。没有丢失过为 null。
   */
  lostBefore: string | null;
  /** 上面的限制自动解除的时刻（那之前发出的命令到时都已过期）。 */
  lostUntil: string | null;
  /** 账本文件暂时读不出来（权限、磁盘错误）：手机派单全部拒绝（DISPATCH_LEDGER_UNAVAILABLE），下次派单时重读。 */
  unavailable: boolean;
};

export type DispatchStatus = DispatchConfig & {
  claude: DispatchClaudeStatus;
  runs: DispatchRunView[];
  requestLedger: DispatchLedgerStatus;
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
  /**
   * 幂等键：手机命令传命令 ID，桌面点按不传。同一个 requestId 只会建一次派单——再来时直接返回
   * 那次派单的当前视图（或原样拒绝），绝不再起会话；账本条目在起进程之前落盘，宿主重启后仍有效。
   */
  requestId?: string;
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
  /** 测试注入用：查询进程出生标识（识别 PID 复用），拿不到返回 null；默认见 process.ts 的 defaultProcessIdentity。 */
  processIdentity?: (pid: number) => Promise<string | null>;
  /** 测试注入用：PID 是否还在；默认 `process.kill(pid, 0)`。 */
  isPidAlive?: (pid: number) => boolean;
  /** 测试注入用：结束整棵进程树；默认 taskkill /T /F（POSIX 发 SIGKILL 给进程组）。 */
  killProcessTree?: (pid: number) => Promise<KillResult>;
  /** 子进程环境的来源，默认 process.env。 */
  baseEnv?: NodeJS.ProcessEnv;
  /** `claude auth status` 的超时，默认 5 秒；超时按「没探出来」处理。 */
  authProbeTimeoutMs?: number;
  /**
   * 宿主收尾：中止即 close()。还在修正残留、处理队列的派单器到下一步就停手，不再起会话、不再读任务；
   * 排队与残留记录原样留给下次启动。
   */
  signal?: AbortSignal;
};

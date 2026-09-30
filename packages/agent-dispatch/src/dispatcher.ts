import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, statSync } from "node:fs";
import { findClaudeCodeCli } from "@ayanami-task/agent-config";
import { noteSuppressed } from "@ayanami-task/errors";
import { ClaudeProbe } from "./claude-probe.js";
import {
  type DispatchConfig,
  loadDispatchConfig,
  mergeDispatchConfig,
  saveDispatchConfig,
} from "./config.js";
import { CLAUDE_LOGIN_REQUIRED_MESSAGE, DispatchError } from "./errors.js";
import { type DispatchPaths, dispatchPaths } from "./files.js";
import {
  claudeArguments,
  DISPATCH_TASK_KEY_PATTERN,
  dispatchChildEnv,
  launchCommand,
  newRunId,
} from "./launch.js";
import { defaultProcessStartTime, isPidAlive, killProcessTree } from "./process.js";
import { renderDispatchPrompt } from "./prompt.js";
import { type DispatchOutcome, judgeOutcome, logHasResult } from "./result.js";
import { loadRuns, pruneLogs, saveRuns, toRunView, trimHistory } from "./run-store.js";
import type {
  AgentDispatcherOptions,
  DispatchChangeEvent,
  DispatchHost,
  DispatchLogger,
  DispatchRunRecord,
  DispatchRunView,
  DispatchSpawn,
  DispatchStatus,
  DispatchTask,
  EnqueueInput,
} from "./types.js";

/** 可以派单的任务状态：还没人开工的。 */
const DISPATCHABLE_STATUSES = new Set(["READY", "BACKLOG"]);
/** 重启后判断「记录里的 PID 还是不是当初那个进程」时，创建时间与记录的启动时间允许的误差。 */
const START_TIME_TOLERANCE_MS = 60_000;

const silentLogger: DispatchLogger = { info() {}, warn() {}, error() {} };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** 任务现在不能派单的原因；可以派单返回 null。 */
function taskBlocker(task: DispatchTask, now: Date): string | null {
  if (!DISPATCHABLE_STATUSES.has(task.status))
    return `任务状态是 ${task.status}，只有 READY 或 BACKLOG 的任务可以交给 Claude`;
  if (task.claimedBySessionId) {
    const lease = task.claimLeaseUntil ? Date.parse(task.claimLeaseUntil) : Number.NaN;
    if (Number.isNaN(lease) || lease > now.getTime())
      return `任务已被会话 ${task.claimedBySessionId} 领取`;
  }
  return null;
}

function cleanRequester(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  // eslint-disable-next-line no-control-regex
  const flat = Array.from(value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim());
  return flat.length === 0 ? undefined : flat.slice(0, 60).join("");
}

/**
 * Claude Code 无头派单：只处理用户点名的任务，排队、限并发、起进程、落日志、记历史。
 * 会话进程 detached 且 stdout/stderr 直接写日志文件，宿主退出后会话照常跑完；
 * 宿主重启时 {@link AgentDispatcher.start} 按 PID 与日志把残留的 running 记录修正或重新接管。
 */
export class AgentDispatcher {
  readonly #paths: DispatchPaths;
  readonly #host: DispatchHost;
  readonly #resolveClaude: () => string | null;
  readonly #spawn: DispatchSpawn;
  readonly #now: () => Date;
  readonly #logger: DispatchLogger;
  readonly #pollIntervalMs: number;
  readonly #processStartTime: (pid: number) => Promise<Date | null>;
  readonly #baseEnv: NodeJS.ProcessEnv;
  #config: DispatchConfig;
  /** 按创建时间升序。 */
  #runs: DispatchRunRecord[];
  readonly #children = new Map<string, ChildProcess>();
  readonly #watchers = new Map<string, NodeJS.Timeout>();
  readonly #launching = new Set<string>();
  readonly #listeners = new Set<(event: DispatchChangeEvent) => void>();
  /** 项目名只在排队到启动之间用来渲染提示词，不进历史文件。 */
  readonly #promptContext = new Map<string, string>();
  readonly #probe: ClaudeProbe;
  #closed = false;

  constructor(options: AgentDispatcherOptions) {
    this.#paths = dispatchPaths(options.dataDir);
    this.#host = options.host;
    this.#resolveClaude = options.resolveClaude ?? findClaudeCodeCli;
    this.#spawn = options.spawnImpl ?? spawn;
    this.#now = options.now ?? (() => new Date());
    this.#logger = options.logger ?? silentLogger;
    this.#pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.#processStartTime = options.processStartTime ?? defaultProcessStartTime;
    this.#baseEnv = options.baseEnv ?? process.env;
    this.#probe = new ClaudeProbe({
      baseEnv: this.#baseEnv,
      now: this.#now,
      ...(options.authProbeTimeoutMs === undefined
        ? {}
        : { authTimeoutMs: options.authProbeTimeoutMs }),
    });
    this.#config = loadDispatchConfig(this.#paths.config, this.#logger);
    this.#runs = loadRuns(this.#paths.runs, this.#logger);
  }

  /** 修正上次留下的 running 记录、清理旧日志，然后开始处理队列。 */
  async start(): Promise<void> {
    for (const record of this.#runs.filter((entry) => entry.state === "running"))
      await this.#reconcileResidual(record);
    if (!this.#config.enabled) this.#cancelQueued("派单已关闭");
    this.#persist();
    this.#pump();
  }

  /** 停止内部计时器；不结束任何会话（它们本来就与宿主解耦）。 */
  close(): void {
    this.#closed = true;
    for (const timer of this.#watchers.values()) clearInterval(timer);
    this.#watchers.clear();
    this.#listeners.clear();
  }

  get config(): DispatchConfig {
    return { ...this.#config };
  }

  onChange(listener: (event: DispatchChangeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 最近的在前。 */
  listRuns(): DispatchRunView[] {
    return [...this.#runs].reverse().map(toRunView);
  }

  /** 该任务最近一次派单（进行中的优先）；从没派过返回 null。 */
  runForTask(project: string, key: string): DispatchRunView | null {
    const runs = this.#runs.filter((record) => record.project === project && record.key === key);
    const active = runs.filter((record) => record.state === "queued" || record.state === "running");
    const pick = active.at(-1) ?? runs.at(-1);
    return pick ? toRunView(pick) : null;
  }

  async status(): Promise<DispatchStatus> {
    const path = this.#resolveClaude();
    const [version, auth] = path
      ? await Promise.all([this.#probe.version(path), this.#probe.auth(path)])
      : [null, null];
    const authMethod = auth?.state.authMethod;
    return {
      ...this.#config,
      claude: {
        found: path !== null,
        path,
        ...(version ? { version } : {}),
        loggedIn: auth?.state.loggedIn ?? null,
        ...(authMethod ? { authMethod } : {}),
      },
      runs: this.listRuns(),
    };
  }

  async updateConfig(patch: unknown): Promise<DispatchConfig> {
    const next = mergeDispatchConfig(this.#config, patch);
    saveDispatchConfig(this.#paths.config, next);
    this.#config = next;
    if (!next.enabled) this.#cancelQueued("派单已关闭");
    this.#persist();
    this.#emit({ type: "config", config: { ...next } });
    this.#pump();
    return { ...next };
  }

  async enqueue(input: EnqueueInput): Promise<DispatchRunView> {
    if (input.origin !== "mobile" && input.origin !== "desktop")
      throw new DispatchError("DISPATCH_INVALID_ARGUMENT", "origin 只能是 mobile 或 desktop");
    if (typeof input.key !== "string" || !DISPATCH_TASK_KEY_PATTERN.test(input.key))
      throw new DispatchError(
        "DISPATCH_INVALID_ARGUMENT",
        `任务键格式不合法：${String(input.key)}`,
      );
    if (!this.#config.enabled)
      throw new DispatchError(
        "DISPATCH_DISABLED",
        "派单未开启：请先在 ATM 设置里打开「交给 Claude」",
      );
    this.#assertNotActive(input.project, input.key);
    const claude = this.#resolveClaude();
    if (claude === null)
      throw new DispatchError(
        "DISPATCH_CLAUDE_NOT_FOUND",
        "找不到 Claude Code 命令行（claude）：请先安装 Claude Code 并确认能在终端里运行 claude",
      );
    await this.#assertLoggedIn(claude);
    const project = await this.#host.getProject(input.project);
    if (!project)
      throw new DispatchError("DISPATCH_PROJECT_NOT_FOUND", `项目不存在：${input.project}`, {
        project: input.project,
      });
    const cwd = project.paths.find(isDirectory);
    if (!cwd)
      throw new DispatchError(
        "DISPATCH_PROJECT_PATH_MISSING",
        project.paths.length === 0
          ? `项目 ${project.code} 没有绑定工作目录，Claude 不知道在哪里干活：请先在 ATM 里给项目绑定目录`
          : `项目 ${project.code} 绑定的目录都不存在`,
        { project: project.code, paths: project.paths },
      );
    if (!input.key.startsWith(`${project.code}-`))
      throw new DispatchError(
        "DISPATCH_TASK_NOT_FOUND",
        `${input.key} 不属于项目 ${project.code}`,
        {
          project: project.code,
          key: input.key,
        },
      );
    const task = await this.#host.getTask(project.code, input.key);
    if (!task)
      throw new DispatchError("DISPATCH_TASK_NOT_FOUND", `任务不存在：${input.key}`, {
        project: project.code,
        key: input.key,
      });
    const blocker = taskBlocker(task, this.#now());
    if (blocker)
      throw new DispatchError("DISPATCH_TASK_NOT_READY", blocker, {
        key: task.key,
        status: task.status,
        claimedBySessionId: task.claimedBySessionId,
        claimLeaseUntil: task.claimLeaseUntil,
      });
    // 上面有 await：同一任务的两次请求可能交错，插入前再查一次。
    if (!this.#config.enabled)
      throw new DispatchError(
        "DISPATCH_DISABLED",
        "派单未开启：请先在 ATM 设置里打开「交给 Claude」",
      );
    this.#assertNotActive(project.code, task.key);
    const now = this.#now();
    const requestedBy = cleanRequester(input.requestedBy);
    const record: DispatchRunRecord = {
      run: newRunId(now),
      project: project.code,
      key: task.key,
      title: task.title,
      origin: input.origin,
      state: "queued",
      sessionId: randomUUID(),
      createdAt: now.toISOString(),
      cwd,
      ...(requestedBy === undefined ? {} : { requestedBy }),
    };
    this.#runs.push(record);
    this.#promptContext.set(record.run, project.name);
    this.#persist();
    this.#emit({ type: "run", run: toRunView(record) });
    this.#pump();
    return toRunView(record);
  }

  async cancel(run: string): Promise<DispatchRunView> {
    const record = this.#runs.find((entry) => entry.run === run);
    if (!record) throw new DispatchError("DISPATCH_RUN_NOT_FOUND", `派单不存在：${run}`, { run });
    if (record.state !== "queued" && record.state !== "running")
      throw new DispatchError("DISPATCH_RUN_NOT_ACTIVE", `派单已结束（${record.state}）`, {
        run,
        state: record.state,
      });
    const pid = record.state === "running" ? record.pid : undefined;
    this.#finish(record, { state: "cancelled", error: "用户取消" });
    if (pid !== undefined) {
      this.#stopWatching(run);
      try {
        await killProcessTree(pid);
      } catch (error) {
        this.#logger.warn("结束派单进程失败", { run, pid, error: errorText(error) });
      }
    }
    return toRunView(record);
  }

  // ---- 内部 ----

  /**
   * 缓存说「未登录」时先强制重探一次（用户可能刚在终端登录完），仍未登录才拒绝；
   * 探不出来（null）照常排队，真没登录会在会话结束时按鉴权失败报出来。
   */
  async #assertLoggedIn(claude: string): Promise<void> {
    let auth = await this.#probe.auth(claude);
    if (auth.state.loggedIn === false && auth.fromCache)
      auth = await this.#probe.auth(claude, { force: true });
    if (auth.state.loggedIn === false)
      throw new DispatchError("DISPATCH_CLAUDE_NOT_LOGGED_IN", CLAUDE_LOGIN_REQUIRED_MESSAGE, {
        ...(auth.state.authMethod ? { authMethod: auth.state.authMethod } : {}),
      });
  }

  /** 按日志判定结局；鉴权失败时让登录状态缓存失效，状态页与下次派单都会重新探。 */
  #judge(record: DispatchRunRecord, exitCode: number | null): DispatchOutcome {
    const outcome = judgeOutcome(
      this.#paths.stdoutLog(record.run),
      this.#paths.stderrLog(record.run),
      exitCode,
    );
    if (outcome.authFailure) this.#probe.invalidateAuth();
    return outcome;
  }

  #assertNotActive(project: string, key: string): void {
    const active = this.#runs.find(
      (record) =>
        record.project === project &&
        record.key === key &&
        (record.state === "queued" || record.state === "running"),
    );
    if (active)
      throw new DispatchError("DISPATCH_ALREADY_ACTIVE", `${key} 已经在派单中（${active.state}）`, {
        run: active.run,
        state: active.state,
      });
  }

  #emit(event: DispatchChangeEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        this.#logger.warn("派单状态监听器抛出异常", { error: errorText(error) });
      }
    }
  }

  #persist(): void {
    const kept = trimHistory(this.#runs);
    this.#runs = kept;
    try {
      saveRuns(this.#paths.runs, kept);
    } catch (error) {
      this.#logger.error("写派单历史失败", { error: errorText(error) });
    }
    pruneLogs(this.#paths, new Set(kept.map((record) => record.run)), this.#logger);
  }

  #finish(
    record: DispatchRunRecord,
    outcome: Pick<DispatchRunRecord, "state" | "summary" | "error"> & { exitCode?: number | null },
  ): void {
    record.state = outcome.state;
    record.endedAt = this.#now().toISOString();
    if (outcome.summary !== undefined) record.summary = outcome.summary;
    if (outcome.error !== undefined) record.error = outcome.error;
    if (outcome.exitCode !== undefined) record.exitCode = outcome.exitCode;
    this.#promptContext.delete(record.run);
    this.#persist();
    this.#emit({ type: "run", run: toRunView(record) });
    this.#pump();
  }

  #cancelQueued(reason: string): void {
    for (const record of this.#runs) {
      if (record.state !== "queued") continue;
      record.state = "cancelled";
      record.endedAt = this.#now().toISOString();
      record.error = reason;
      this.#promptContext.delete(record.run);
      this.#emit({ type: "run", run: toRunView(record) });
    }
  }

  #pump(): void {
    if (this.#closed || !this.#config.enabled) return;
    const running = this.#runs.filter((record) => record.state === "running").length;
    let slots = this.#config.maxConcurrent - running - this.#launching.size;
    for (const record of this.#runs) {
      if (slots <= 0) break;
      if (record.state !== "queued" || this.#launching.has(record.run)) continue;
      slots -= 1;
      this.#launching.add(record.run);
      void this.#launch(record)
        .catch((error: unknown) => {
          if (record.state === "queued")
            this.#finish(record, { state: "failed", error: `启动失败：${errorText(error)}` });
        })
        .finally(() => {
          this.#launching.delete(record.run);
          this.#pump();
        });
    }
  }

  async #launch(record: DispatchRunRecord): Promise<void> {
    const claude = this.#resolveClaude();
    if (claude === null) {
      this.#finish(record, { state: "failed", error: "找不到 Claude Code 命令行（claude）" });
      return;
    }
    // 排队期间任务可能已被别人领取或改了状态，起一个注定要退出的会话没有意义。
    const task = await this.#host.getTask(record.project, record.key);
    if (record.state !== "queued") return; // 等待期间被取消。
    const blocker = task ? taskBlocker(task, this.#now()) : "任务已不存在";
    if (blocker) {
      this.#finish(record, { state: "cancelled", error: `排队期间任务状态已变化：${blocker}` });
      return;
    }
    const projectName =
      this.#promptContext.get(record.run) ??
      (await this.#host.getProject(record.project))?.name ??
      record.project;
    if (record.state !== "queued") return;
    const args = claudeArguments({
      sessionId: record.sessionId,
      key: record.key,
      config: this.#config,
    });
    const command = launchCommand(claude, args);
    const prompt = renderDispatchPrompt({
      run: record.run,
      projectCode: record.project,
      projectName,
      cwd: record.cwd,
      key: record.key,
      title: task?.title ?? record.title,
      origin: record.origin,
      ...(record.requestedBy === undefined ? {} : { requestedBy: record.requestedBy }),
    });
    mkdirSync(this.#paths.logs, { recursive: true });
    const stdout = openSync(this.#paths.stdoutLog(record.run), "a");
    const stderr = openSync(this.#paths.stderrLog(record.run), "a");
    let child: ChildProcess;
    try {
      child = this.#spawn(command.command, command.args, {
        cwd: record.cwd,
        env: dispatchChildEnv(this.#baseEnv, record.run),
        // stdout/stderr 直接接文件而不是管道：宿主退出后会话还能继续写日志。
        stdio: ["pipe", stdout, stderr],
        detached: true,
        windowsHide: true,
        ...(command.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
    } catch (error) {
      // 关文件句柄再失败也不能盖掉「为什么没起来」：次要错误挂在主错误的 suppressed 上。
      for (const fd of [stdout, stderr]) {
        try {
          closeSync(fd);
        } catch (closeError) {
          noteSuppressed(error, closeError);
        }
      }
      throw error;
    }
    // 子进程已经继承了自己的一份句柄，父进程这份立刻关掉。
    closeSync(stdout);
    closeSync(stderr);
    this.#children.set(record.run, child);
    child.once("error", (error) => this.#onChildError(record.run, error));
    child.once("exit", (code) => this.#onChildExit(record.run, code));
    if (child.pid !== undefined) record.pid = child.pid;
    record.state = "running";
    record.startedAt = this.#now().toISOString();
    this.#promptContext.delete(record.run);
    // 提示词走 stdin，写完即关，会话读到 EOF 就开始工作。
    child.stdin?.on("error", (error) =>
      this.#logger.warn("写派单提示词失败", { run: record.run, error: errorText(error) }),
    );
    child.stdin?.end(prompt, "utf8");
    child.unref();
    this.#persist();
    this.#emit({ type: "run", run: toRunView(record) });
    this.#logger.info("已派单", { run: record.run, key: record.key, pid: child.pid });
  }

  #onChildError(run: string, error: Error): void {
    this.#children.delete(run);
    const record = this.#runs.find((entry) => entry.run === run);
    if (!record || record.state !== "running") return;
    this.#finish(record, { state: "failed", error: `无法启动 claude：${errorText(error)}` });
  }

  #onChildExit(run: string, code: number | null): void {
    this.#children.delete(run);
    const record = this.#runs.find((entry) => entry.run === run);
    if (!record) return;
    if (record.state !== "running") {
      // 已取消：只补记退出码。
      record.exitCode = code;
      this.#persist();
      return;
    }
    const outcome = this.#judge(record, code);
    this.#finish(record, { ...outcome, exitCode: code });
  }

  /** 上次宿主退出时仍在跑的记录：进程还在（且确是同一个进程）就接着跟踪，否则按日志定结局。 */
  async #reconcileResidual(record: DispatchRunRecord): Promise<void> {
    const pid = record.pid;
    let alive = pid !== undefined && isPidAlive(pid);
    if (alive && pid !== undefined) {
      const created = await this.#processStartTime(pid).catch(() => null);
      const started = record.startedAt ? Date.parse(record.startedAt) : Number.NaN;
      if (created && !Number.isNaN(started))
        alive = Math.abs(created.getTime() - started) <= START_TIME_TOLERANCE_MS;
      // 拿不到创建时间：以日志里有无 result 行为准（有 result 说明会话已经结束，PID 被复用了）。
      else alive = !logHasResult(this.#paths.stdoutLog(record.run));
    }
    if (alive && pid !== undefined) {
      this.#watch(record, pid);
      return;
    }
    const outcome = this.#judge(record, null);
    record.state = outcome.state;
    record.endedAt = this.#now().toISOString();
    if (outcome.summary) record.summary = outcome.summary;
    if (outcome.error) record.error = `宿主重启时会话已结束；${outcome.error}`;
    this.#emit({ type: "run", run: toRunView(record) });
  }

  /** 接管不是本进程子进程的会话：轮询 PID，进程消失后按日志定结局。 */
  #watch(record: DispatchRunRecord, pid: number): void {
    const timer = setInterval(() => {
      if (isPidAlive(pid)) return;
      this.#stopWatching(record.run);
      if (record.state !== "running") return;
      this.#finish(record, this.#judge(record, null));
    }, this.#pollIntervalMs);
    timer.unref();
    this.#watchers.set(record.run, timer);
  }

  #stopWatching(run: string): void {
    const timer = this.#watchers.get(run);
    if (timer) clearInterval(timer);
    this.#watchers.delete(run);
  }
}

/** 构造并启动（修正残留、开始处理队列）。 */
export async function createAgentDispatcher(
  options: AgentDispatcherOptions,
): Promise<AgentDispatcher> {
  const dispatcher = new AgentDispatcher(options);
  await dispatcher.start();
  return dispatcher;
}

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { findClaudeCodeCli } from "@ayanami-task/agent-config";
import {
  admitTask,
  cleanRequester,
  closedError,
  disabledError,
  openOnly,
  taskBlocker,
  whileOpen,
} from "./admission.js";
import { ClaudeProbe } from "./claude-probe.js";
import {
  type DispatchConfig,
  loadDispatchConfig,
  mergeDispatchConfig,
  saveDispatchConfig,
} from "./config.js";
import { CLAUDE_LOGIN_REQUIRED_MESSAGE, DispatchError, isDispatchError } from "./errors.js";
import { type DispatchPaths, dispatchPaths } from "./files.js";
import {
  claudeArguments,
  DISPATCH_TASK_KEY_PATTERN,
  dispatchChildEnv,
  launchCommand,
  newRunId,
  spawnSession,
} from "./launch.js";
import {
  checkProcessIdentity,
  defaultProcessProbe,
  type ProcessProbe,
} from "./process-identity.js";
import { ProcessTracker } from "./process-tracker.js";
import { renderDispatchPrompt } from "./prompt.js";
import { type DispatchOutcome, identityLostMessage, judgeOutcome, logHasResult } from "./result.js";
import {
  DISPATCH_REQUEST_ID_PATTERN,
  type DispatchRequestEntry,
  type LedgerReservation,
  RequestLedger,
  snapshotView,
} from "./request-ledger.js";
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
  EnqueueInput,
} from "./types.js";

const silentLogger: DispatchLogger = { info() {}, warn() {}, error() {} };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Claude Code 无头派单：只处理用户点名的任务，排队、限并发、起进程、落日志、记历史。
 * 会话进程 detached 且 stdout/stderr 直接写日志文件，宿主退出后会话照常跑完；
 * 宿主重启时 {@link AgentDispatcher.start} 只接管身份（PID + 出生标识，精确相等）确认无误的残留进程。
 * 带 requestId 的请求（手机命令）经 {@link RequestLedger} 持久幂等：同一个 ID 绝不起第二次会话。
 */
export class AgentDispatcher {
  readonly #paths: DispatchPaths;
  readonly #host: DispatchHost;
  readonly #resolveClaude: () => string | null;
  readonly #spawn: DispatchSpawn;
  readonly #now: () => Date;
  readonly #logger: DispatchLogger;
  readonly #process: ProcessProbe;
  readonly #tracker: ProcessTracker;
  readonly #ledger: RequestLedger;
  readonly #baseEnv: NodeJS.ProcessEnv;
  #config: DispatchConfig;
  /** 按创建时间升序。 */
  #runs: DispatchRunRecord[];
  readonly #launching = new Set<string>();
  /** 进行中的取消：同一次派单再点取消拿到同一个结果，不会并发结束两次。 */
  readonly #cancelling = new Map<string, Promise<DispatchRunView>>();
  readonly #listeners = new Set<(event: DispatchChangeEvent) => void>();
  /** 项目名只在排队到启动之间用来渲染提示词，不进历史文件。 */
  readonly #promptContext = new Map<string, string>();
  readonly #probe: ClaudeProbe;
  #closed = false;
  /** close() 时中止：在途的入队不等登录探测、读库回来，立即以 DISPATCH_CLOSED 结束。 */
  readonly #lifetime = new AbortController();

  constructor(options: AgentDispatcherOptions) {
    this.#paths = dispatchPaths(options.dataDir);
    // 关闭后（宿主收尾、随后关库）任何在途步骤都不能再读库。
    this.#host = openOnly(options.host, () => this.#closed);
    this.#resolveClaude = options.resolveClaude ?? findClaudeCodeCli;
    this.#spawn = options.spawnImpl ?? spawn;
    this.#now = options.now ?? (() => new Date());
    this.#logger = options.logger ?? silentLogger;
    this.#process = {
      isAlive: options.isPidAlive ?? defaultProcessProbe.isAlive,
      identity: options.processIdentity ?? defaultProcessProbe.identity,
      killTree: options.killProcessTree ?? defaultProcessProbe.killTree,
    };
    this.#tracker = new ProcessTracker({
      probe: this.#process,
      pollIntervalMs: options.pollIntervalMs ?? 5_000,
      logger: this.#logger,
      events: {
        exited: (run, code) => this.#onExit(run, code),
        failed: (run, error) => this.#onSpawnError(run, error),
        lost: (run) => this.#onLost(run),
      },
    });
    this.#baseEnv = options.baseEnv ?? process.env;
    this.#probe = new ClaudeProbe({
      baseEnv: this.#baseEnv,
      now: this.#now,
      ...(options.authProbeTimeoutMs === undefined
        ? {}
        : { authTimeoutMs: options.authProbeTimeoutMs }),
    });
    this.#config = loadDispatchConfig(this.#paths.config, this.#logger);
    const history = loadRuns(this.#paths.runs, this.#logger);
    this.#runs = history.runs;
    // 账本按需重读时要看当时的派单历史（补回带 requestId 的条目、判断是不是丢了数据）。
    this.#ledger = new RequestLedger(
      this.#paths.requests,
      this.#logger,
      () => ({ runs: this.#runs, damaged: history.damaged, requestsSince: history.requestsSince }),
      this.#now(),
      (since) => saveRuns(this.#paths.runs, this.#runs, since),
    );
    if (options.signal?.aborted) this.close();
    else options.signal?.addEventListener("abort", () => this.close(), { once: true });
  }

  /** 修正上次留下的 running 记录、清理旧日志，然后开始处理队列。 */
  async start(): Promise<void> {
    for (const record of this.#runs.filter((entry) => entry.state === "running")) {
      if (this.#closed) return;
      await this.#reconcileResidual(record);
    }
    // 修正期间宿主开始收尾：剩下的残留与队列留给下次启动。
    if (this.#closed) return;
    if (!this.#config.enabled) this.#cancelQueued("派单已关闭");
    this.#persist();
    this.#pump();
  }

  /** 停止内部计时器；不结束任何会话（它们本来就与宿主解耦）。 */
  close(): void {
    this.#closed = true;
    this.#lifetime.abort();
    this.#tracker.close();
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
      requestLedger: this.#ledger.status(this.#now()),
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

  /**
   * 排队一次派单。带 `requestId` 时先过请求账本（{@link RequestLedger.admit}）：记过的直接回放那次的结局
   * （派单的当前视图，或当初的拒绝），绝不再起会话；账本不可用、丢失水位线之前发出的、账本满了的直接拒绝；
   * 其余预留名额后照常校验，建出派单或业务拒绝都记进账本。关闭后（宿主收尾）抛 DISPATCH_CLOSED，不记账本。
   */
  async enqueue(input: EnqueueInput): Promise<DispatchRunView> {
    if (this.#closed) throw closedError();
    if (input.origin !== "mobile" && input.origin !== "desktop")
      throw new DispatchError("DISPATCH_INVALID_ARGUMENT", "origin 只能是 mobile 或 desktop");
    if (typeof input.key !== "string" || !DISPATCH_TASK_KEY_PATTERN.test(input.key))
      throw new DispatchError(
        "DISPATCH_INVALID_ARGUMENT",
        `任务键格式不合法：${String(input.key)}`,
      );
    const requestId = input.requestId;
    if (requestId === undefined) return this.#enqueueNew(input);
    if (typeof requestId !== "string" || !DISPATCH_REQUEST_ID_PATTERN.test(requestId))
      throw new DispatchError("DISPATCH_INVALID_ARGUMENT", "requestId 格式不合法");
    const gate = this.#ledger.admit(requestId, this.#now());
    if (gate.kind === "replay") return this.#replay(gate.entry);
    try {
      return await this.#enqueueNew(input, gate.reservation);
    } catch (error) {
      // 业务上的拒绝也记下来：同一条命令以后再来（重放、回执写失败后重处理）照样拒绝，
      // 不会因为期间开了派单、任务变回 READY 就补起一次会话。临时故障（例如库打不开）与
      // 可重试的拒绝（例如宿主正在退出）不记：那不是对这条命令的判断，以后再来照常处理。
      if (isDispatchError(error) && !error.retryable)
        this.#ledger.recordRejection(gate.reservation, error, this.#now());
      throw error;
    } finally {
      this.#ledger.release(gate.reservation);
    }
  }

  /** 账本里记过的请求：返回那次派单的当前视图（还在历史里用历史，已被裁剪用账本快照），或原样拒绝。 */
  #replay(entry: DispatchRequestEntry): DispatchRunView {
    if ("rejected" in entry)
      throw new DispatchError(entry.rejected.code, entry.rejected.message, { requestId: entry.id });
    const record = this.#runs.find((candidate) => candidate.run === entry.run.run);
    return record ? toRunView(record) : snapshotView(entry.run);
  }

  async #enqueueNew(
    input: EnqueueInput,
    reservation?: LedgerReservation,
  ): Promise<DispatchRunView> {
    if (!this.#config.enabled) throw disabledError();
    this.#assertNotActive(input.project, input.key);
    const claude = this.#resolveClaude();
    if (claude === null)
      throw new DispatchError(
        "DISPATCH_CLAUDE_NOT_FOUND",
        "找不到 Claude Code 命令行（claude）：请先安装 Claude Code 并确认能在终端里运行 claude",
      );
    await whileOpen(this.#assertLoggedIn(claude), this.#lifetime.signal);
    if (this.#closed) throw closedError();
    const admitted = admitTask(this.#host, input, this.#now);
    const { project, task, cwd } = await whileOpen(admitted, this.#lifetime.signal);
    // 上面有 await：期间可能已关闭，或同一任务（或同一请求）的两次调用交错，插入前再查一次。
    if (this.#closed) throw closedError();
    if (reservation !== undefined) {
      const raced = this.#ledger.find(reservation.id, this.#now());
      if (raced) return this.#replay(raced);
    }
    if (!this.#config.enabled) throw disabledError();
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
      // 历史里也存一份命令 ID：账本丢了还能据此补回「这条命令派过哪次」。
      ...(reservation === undefined ? {} : { requestId: reservation.id }),
    };
    this.#runs.push(record);
    if (reservation !== undefined) {
      // 先落账本再排队起进程：账本写不下去就不派，免得崩溃或回执失败后重处理时再起一次。
      try {
        this.#ledger.recordRun(reservation, toRunView(record), now);
      } catch (error) {
        this.#runs = this.#runs.filter((candidate) => candidate !== record);
        throw new Error(`写派单请求账本失败，没有启动 Claude：${errorText(error)}`);
      }
    }
    this.#promptContext.set(record.run, project.name);
    this.#persist();
    this.#emit({ type: "run", run: toRunView(record) });
    this.#pump();
    return toRunView(record);
  }

  /**
   * 取消。排队中的直接取消；运行中的先核验进程身份再结束整棵进程树，确认结束后才记为取消并释放名额。
   * 结束失败（或身份核验不了）时派单保持运行中、名额不释放，抛 DISPATCH_CANCEL_FAILED，可以重试。
   */
  async cancel(run: string): Promise<DispatchRunView> {
    const pending = this.#cancelling.get(run);
    if (pending) return pending;
    const record = this.#runs.find((entry) => entry.run === run);
    if (!record) throw new DispatchError("DISPATCH_RUN_NOT_FOUND", `派单不存在：${run}`, { run });
    if (record.state !== "queued" && record.state !== "running")
      throw new DispatchError("DISPATCH_RUN_NOT_ACTIVE", `派单已结束（${record.state}）`, {
        run,
        state: record.state,
      });
    if (record.state === "queued") {
      this.#finish(record, { state: "cancelled", error: "用户取消" });
      return toRunView(record);
    }
    const work = this.#cancelRunning(record).finally(() => this.#cancelling.delete(run));
    this.#cancelling.set(run, work);
    return work;
  }

  async #cancelRunning(record: DispatchRunRecord): Promise<DispatchRunView> {
    const outcome = await this.#tracker.terminate(record.run, record.pid, record.processIdentity);
    if (record.state === "running") {
      // `exited`：核验发现原进程早已退出（PID 不在或已换人），没动任何进程，按日志定结局。
      if (outcome === "exited") this.#finish(record, this.#judge(record, null));
      else this.#finish(record, { state: "cancelled", error: "用户取消" });
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
    // 先用完整历史刷新账本快照：下面裁剪掉的派单，账本里留的是它最后的状态。
    this.#ledger.sync(this.#runs, toRunView);
    const kept = trimHistory(this.#runs);
    this.#runs = kept;
    try {
      saveRuns(this.#paths.runs, kept, this.#ledger.requestsSince);
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
          // 关闭后的失败（读库被拒、库已关）不是这次派单的问题：记录留在队列里给下次启动。
          if (!this.#closed && record.state === "queued")
            this.#finish(record, { state: "failed", error: `启动失败：${errorText(error)}` });
        })
        .finally(() => {
          this.#launching.delete(record.run);
          this.#pump();
        });
    }
  }

  async #launch(record: DispatchRunRecord): Promise<void> {
    // #pump 只在没关时调这里；之后每次 await 回来都再看一眼：宿主收尾（close）后不起会话，记录留在队列里。
    const claude = this.#resolveClaude();
    if (claude === null) {
      this.#finish(record, { state: "failed", error: "找不到 Claude Code 命令行（claude）" });
      return;
    }
    // 排队期间任务可能已被别人领取或改了状态，起一个注定要退出的会话没有意义。
    const task = await this.#host.getTask(record.project, record.key);
    if (this.#closed || record.state !== "queued") return; // 等待期间被取消或宿主在收尾。
    const blocker = task ? taskBlocker(task, this.#now()) : "任务已不存在";
    if (blocker) {
      this.#finish(record, { state: "cancelled", error: `排队期间任务状态已变化：${blocker}` });
      return;
    }
    const projectName =
      this.#promptContext.get(record.run) ??
      (await this.#host.getProject(record.project))?.name ??
      record.project;
    if (this.#closed || record.state !== "queued") return;
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
    const child = spawnSession({
      spawn: this.#spawn,
      command,
      cwd: record.cwd,
      env: dispatchChildEnv(this.#baseEnv, record.run),
      stdoutLog: this.#paths.stdoutLog(record.run),
      stderrLog: this.#paths.stderrLog(record.run),
    });
    // 句柄挂上 exit/error，同时立刻向 OS 要这个 PID 的出生标识（宿主重启后据此核验身份）。
    const identity = this.#tracker.attach(record.run, child);
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
    void identity.then((born) => {
      if (record.state !== "running") return;
      if (born === null) {
        this.#logger.warn("查不到会话进程的出生标识：宿主重启后不会接管它", { run: record.run });
        return;
      }
      record.processIdentity = born;
      this.#persist();
    });
  }

  #onSpawnError(run: string, error: Error): void {
    const record = this.#runs.find((entry) => entry.run === run);
    if (!record || record.state !== "running") return;
    this.#finish(record, { state: "failed", error: `无法启动 claude：${errorText(error)}` });
  }

  /** 进程结束：句柄的 exit（带退出码）或接管轮询发现进程已不在（不带）。取消进行中时结局由取消流程定。 */
  #onExit(run: string, code?: number | null): void {
    const record = this.#runs.find((entry) => entry.run === run);
    if (!record) return;
    if (record.state !== "running" || this.#cancelling.has(run)) {
      if (code !== undefined) record.exitCode = code;
      this.#persist();
      return;
    }
    const outcome = this.#judge(record, code ?? null);
    this.#finish(record, { ...outcome, ...(code === undefined ? {} : { exitCode: code }) });
  }

  /** 接管的进程身份连续核验不了：停止跟踪，不结束进程，结局记为失败并说明。 */
  #onLost(run: string): void {
    const record = this.#runs.find((entry) => entry.run === run);
    if (!record || record.state !== "running") return;
    this.#finish(record, {
      state: "failed",
      error: identityLostMessage(record.pid, "接管后连续几次"),
    });
  }

  /**
   * 上次宿主退出时仍在跑的记录。只有「记录里的出生标识已知 + 现查的已知 + 两者逐字相同」才接着跟踪；
   * PID 不在或已换人（原进程肯定已退出）按日志定结局；身份核验不了时绝不接管、绝不结束：
   * 日志里已有 result 行（会话已结束）按日志定结局，否则记为失败并说明（进程可能还在，由用户处理）。
   */
  async #reconcileResidual(record: DispatchRunRecord): Promise<void> {
    const pid = record.pid;
    const identity =
      pid === undefined
        ? "gone"
        : await checkProcessIdentity(this.#process, pid, record.processIdentity);
    // 核验期间被取消，或宿主在收尾（残留留给下次启动再核验）。
    if (this.#closed || record.state !== "running") return;
    if (identity === "same" && pid !== undefined && record.processIdentity !== undefined) {
      this.#tracker.watch(record.run, pid, record.processIdentity);
      return;
    }
    record.endedAt = this.#now().toISOString();
    if (identity === "unknown" && !logHasResult(this.#paths.stdoutLog(record.run))) {
      record.state = "failed";
      record.error = identityLostMessage(pid, "宿主重启后");
    } else {
      const outcome = this.#judge(record, null);
      record.state = outcome.state;
      if (outcome.summary) record.summary = outcome.summary;
      if (outcome.error) record.error = `宿主重启时会话已结束；${outcome.error}`;
    }
    this.#emit({ type: "run", run: toRunView(record) });
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

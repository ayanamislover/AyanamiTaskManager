import type { ChildProcess } from "node:child_process";
import { DispatchError } from "./errors.js";
import {
  captureIdentity,
  checkProcessIdentity,
  childRunning,
  type ProcessProbe,
} from "./process-identity.js";
import type { DispatchLogger } from "./types.js";

/** 接管的进程连续这么多次查不到出生标识（身份核验不了）就停止跟踪；进程本身不动。 */
export const IDENTITY_MISS_LIMIT = 3;

export type ProcessTrackerEvents = {
  /** 会话进程已结束：句柄的 exit 事件（带退出码），或轮询发现 PID 不在 / 已换成别的进程（不带）。 */
  exited(run: string, exitCode?: number | null): void;
  /** 子进程没能起来（spawn 后的 'error' 事件）。 */
  failed(run: string, error: Error): void;
  /** 接管的进程身份连续核验不了：已停止跟踪，没有结束任何进程。 */
  lost(run: string): void;
};

/**
 * - `terminated`：进程树已被强制结束，或结束前它已经不在了；
 * - `exited`：核验发现记录里的进程早已退出（PID 不在或已换人），没有动任何进程。
 */
export type TerminateOutcome = "terminated" | "exited";

function cancelFailed(run: string, pid: number, message: string): DispatchError {
  return new DispatchError("DISPATCH_CANCEL_FAILED", message, { run, pid });
}

/**
 * 跟踪会话进程。本宿主 spawn 的用 ChildProcess 句柄（exit 事件）判断存活——句柄在，系统不会把 PID
 * 分给别的进程；宿主重启后接管的只有 PID，靠「PID + 出生标识」精确核验身份，每次轮询、每次结束前都重核。
 * 任何时候身份对不上都按「原进程已退出」处理，核验不了就不动它：绝不对身份不明的 PID 结束进程树。
 */
export class ProcessTracker {
  readonly #probe: ProcessProbe;
  readonly #pollIntervalMs: number;
  readonly #logger: DispatchLogger;
  readonly #events: ProcessTrackerEvents;
  readonly #children = new Map<string, ChildProcess>();
  readonly #watchers = new Map<string, NodeJS.Timeout>();
  #closed = false;

  constructor(options: {
    probe: ProcessProbe;
    pollIntervalMs: number;
    logger: DispatchLogger;
    events: ProcessTrackerEvents;
  }) {
    this.#probe = options.probe;
    this.#pollIntervalMs = options.pollIntervalMs;
    this.#logger = options.logger;
    this.#events = options.events;
  }

  /** 本宿主刚 spawn 的会话：挂上 exit/error，并返回 OS 给的出生标识（查不到为 null，身份记为未知）。 */
  attach(run: string, child: ChildProcess): Promise<string | null> {
    this.#children.set(run, child);
    child.once("error", (error) => {
      this.#children.delete(run);
      this.#events.failed(run, error);
    });
    child.once("exit", (code) => {
      this.#children.delete(run);
      this.#events.exited(run, code);
    });
    return captureIdentity(this.#probe, child);
  }

  /** 宿主重启后接管（调用方已确认身份一致）：轮询，每次都重核 PID + 出生标识。 */
  watch(run: string, pid: number, identity: string): void {
    let misses = 0;
    const tick = async () => {
      if (this.#closed || !this.#watchers.has(run)) return;
      const verdict = await checkProcessIdentity(this.#probe, pid, identity);
      if (this.#closed || !this.#watchers.has(run)) return; // 核验期间被取消或关闭。
      if (verdict === "gone" || verdict === "different") {
        this.#stopWatching(run);
        this.#events.exited(run);
        return;
      }
      misses = verdict === "unknown" ? misses + 1 : 0;
      if (misses >= IDENTITY_MISS_LIMIT) {
        this.#stopWatching(run);
        this.#logger.warn("接管的会话进程身份连续核验不了，已停止跟踪", { run, pid });
        this.#events.lost(run);
        return;
      }
      schedule();
    };
    // setTimeout 链而不是 setInterval：一次核验（起 PowerShell）可能比轮询间隔还长，不能叠起来跑。
    const schedule = () => {
      const timer = setTimeout(() => void tick(), this.#pollIntervalMs);
      timer.unref();
      this.#watchers.set(run, timer);
    };
    schedule();
  }

  #stopWatching(run: string): boolean {
    const timer = this.#watchers.get(run);
    if (timer) clearTimeout(timer);
    return this.#watchers.delete(run);
  }

  /**
   * 用户取消：先核验身份，再结束整棵进程树。
   * - 本宿主 spawn 的：句柄说还没退出就结束（此时 PID 不可能被复用）；
   * - 接管的、或还没进入跟踪的：PID + 出生标识精确一致才结束；PID 不在或已换人返回 `exited`；
   * 核验不了、或结束失败而进程仍在：抛 DISPATCH_CANCEL_FAILED，跟踪照旧（接管的恢复轮询），可以重试。
   */
  async terminate(
    run: string,
    pid: number | undefined,
    identity: string | undefined,
  ): Promise<TerminateOutcome> {
    const child = this.#children.get(run);
    if (child) return this.#terminateChild(run, child);
    if (pid === undefined) return "exited";
    const watching = this.#stopWatching(run);
    try {
      const verdict = await checkProcessIdentity(this.#probe, pid, identity);
      if (verdict === "gone" || verdict === "different") return "exited";
      if (verdict === "unknown")
        throw cancelFailed(
          run,
          pid,
          `暂时确认不了 PID ${pid} 还是不是这次派单的 Claude 进程，为免误杀别的程序没有结束任何进程；请稍后重试，或在任务管理器里手动结束`,
        );
      return await this.#kill(run, pid, () => this.#probe.isAlive(pid));
    } catch (error) {
      if (watching && identity !== undefined && !this.#closed) this.watch(run, pid, identity);
      throw error;
    }
  }

  async #terminateChild(run: string, child: ChildProcess): Promise<TerminateOutcome> {
    const pid = child.pid;
    if (pid === undefined || !childRunning(child)) return "terminated";
    return this.#kill(run, pid, () => childRunning(child) && this.#probe.isAlive(pid));
  }

  async #kill(run: string, pid: number, stillAlive: () => boolean): Promise<TerminateOutcome> {
    const result = await this.#probe.killTree(pid);
    if (result.kind !== "failed") return "terminated";
    // 结束命令报错，但进程其实已经没了（例如恰好自己退出）：照样算结束。
    if (!stillAlive()) return "terminated";
    this.#logger.warn("结束派单进程失败", { run, pid, reason: result.reason });
    throw cancelFailed(
      run,
      pid,
      `没能结束 Claude 进程（PID ${pid}）：${result.reason}。派单仍在进行，可以稍后再点「结束」重试`,
    );
  }

  /** 这次派单的进程还在被跟踪（句柄或轮询）。 */
  tracking(run: string): boolean {
    return this.#children.has(run) || this.#watchers.has(run);
  }

  /** 停掉轮询；不结束任何进程（会话本来就与宿主解耦）。 */
  close(): void {
    this.#closed = true;
    for (const timer of this.#watchers.values()) clearTimeout(timer);
    this.#watchers.clear();
  }
}

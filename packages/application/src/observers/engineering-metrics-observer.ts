import {
  gitHead,
  scanProjectMetrics,
  scanWorkItemChanges,
} from "@ayanami-task/engineering-metrics";
import { asAtmError } from "@ayanami-task/errors";
import type { ApplicationServiceRuntime } from "../runtime/service-runtime.js";

/**
 * 工程变更扫描要跑一串 git 子进程：本仓实测 scanWorkItemChanges 1626ms、
 * scanProjectMetrics 1289ms。现在这些调用是异步的（见 engineering-metrics/git-command.ts），
 * 扫描期间 daemon 照常应答别的请求，但请求本身还是得等它跑完，所以：
 *
 * - 读：手里有一份不太旧的就直接给，稍旧的先给旧的、重扫挪到这次响应之后；
 * - 写：任务状态变更只当场记下 baseline（一条 rev-parse 加一次落库），
 *   真正的 diff 排到响应之后，别让「改个状态」等一秒半。
 *
 * 同一个任务的扫描按登记顺序串行，后登记的后落库；否则「后台补扫」可能压过
 * 用户刚刚要求的那次刷新，界面上就会看到刚刷出来的数字又变回旧值。
 */
const WORK_ITEM_METRICS_FRESH_MS = 60_000;

export class EngineeringMetricsObserver {
  readonly #runtime: ApplicationServiceRuntime;
  readonly #scheduled = new Set<string>();
  readonly #queues = new Map<string, Promise<unknown>>();
  #background: Promise<unknown> = Promise.resolve();

  constructor(runtime: ApplicationServiceRuntime) {
    this.#runtime = runtime;
  }

  async engineeringMetrics(
    projectCode: string,
    input: { taskKey?: string; refresh?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const project = this.#runtime.databases.getProject(projectCode);
    const sourcePath = project.sourcePaths[0];
    if (!sourcePath) {
      return { available: false, reason: "NO_SOURCE_PATH", project: null, workItem: null };
    }
    try {
      const latest = await this.#runtime.databases.latestProjectEngineeringMetrics(projectCode);
      const latestAt = typeof latest?.capturedAt === "string" ? Date.parse(latest.capturedAt) : 0;
      const projectMetrics =
        !input.refresh && latest && Date.now() - latestAt < 5 * 60_000
          ? latest
          : await this.#runtime.databases.saveProjectEngineeringMetrics(
              projectCode,
              await scanProjectMetrics(sourcePath),
            );
      const workItem = input.taskKey
        ? await this.#workItemMetrics(
            projectCode,
            input.taskKey,
            sourcePath,
            input.refresh === true,
          )
        : null;
      return { available: true, root: sourcePath, project: projectMetrics, workItem };
    } catch (error) {
      const typed = asAtmError(error);
      return {
        available: false,
        reason: typed.code === "INTERNAL_ERROR" ? "METRICS_FAILED" : typed.code,
        message: typed.message,
        project: null,
        workItem: null,
      };
    }
  }

  async #workItemMetrics(
    projectCode: string,
    taskKey: string,
    sourcePath: string,
    refresh: boolean,
  ): Promise<Record<string, unknown> | null> {
    const stored = await this.#runtime.databases.workItemEngineeringMetrics(projectCode, taskKey);
    const capturedAt = typeof stored?.capturedAt === "string" ? Date.parse(stored.capturedAt) : 0;
    // 只记了 baseline 还没算出指标的那一行不算「手里有」：直接返回它，界面上「工程变更」
    // 整块都不出现，要等下一次轮询才补上。这种行现在更常见了——状态变更只当场记 baseline。
    if (!refresh && stored?.metrics) {
      if (Date.now() - capturedAt >= WORK_ITEM_METRICS_FRESH_MS) {
        this.#scheduleWorkItemScan(projectCode, taskKey, sourcePath);
      }
      return stored;
    }
    return this.#scanWorkItem(projectCode, taskKey, sourcePath);
  }

  /** 同一个任务的扫描按登记顺序排队，保证最后落库的是最后登记的那一次。 */
  #enqueue<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const next = previous.then(run, run);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.#queues.set(key, settled);
    void settled.then(() => {
      if (this.#queues.get(key) === settled) this.#queues.delete(key);
    });
    return next;
  }

  /**
   * 后台补扫一次只跑一个。
   *
   * 一批状态变更会一口气登记几十上百个任务（atm_end 释放全部领取时更多），而每次扫描
   * 自己就要开七八个 git 子进程。放任它们同时起来，等于把原来那条同步慢路换成一次进程风暴。
   * 反正这些活儿已经不在任何人的等待路径上，串着跑就好。
   */
  #scheduleWorkItemScan(projectCode: string, taskKey: string, sourcePath: string): void {
    const key = JSON.stringify([projectCode, taskKey]);
    if (this.#scheduled.has(key)) return;
    this.#scheduled.add(key);
    const timer = setTimeout(() => {
      // #scanWorkItem 自己会按任务排队，这里再包一层 #enqueue 会等自己的队尾，直接死锁。
      this.#background = this.#background
        .then(() => this.#scanWorkItem(projectCode, taskKey, sourcePath))
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => this.#scheduled.delete(key));
    }, 0);
    // 后台补扫不该拖着进程不退出。
    timer.unref?.();
  }

  async #scanWorkItem(
    projectCode: string,
    taskKey: string,
    sourcePath: string,
  ): Promise<Record<string, unknown>> {
    return this.#enqueue(JSON.stringify([projectCode, taskKey]), async () => {
      const baseline = await this.#runtime.databases.ensureWorkItemEngineeringBaseline(
        projectCode,
        taskKey,
        await gitHead(sourcePath),
      );
      return this.#runtime.databases.saveWorkItemEngineeringMetrics(
        projectCode,
        taskKey,
        baseline.baseline,
        await scanWorkItemChanges(sourcePath, baseline.baseline),
      );
    });
  }

  /**
   * 任务状态变更时的采集。baseline 必须当场记：它锚的是「这个任务从哪个 commit 开始」，
   * 晚记一步就锚错了。真正的 diff 排到响应之后——它对这次状态变更没有任何决定权，
   * 失败也从不回滚已经提交的状态迁移。
   */
  async captureWorkItemEngineeringMetrics(
    projectCode: string,
    taskKeys: string[],
    establishBaseline: boolean,
  ): Promise<void> {
    const keys = [...new Set(taskKeys)];
    if (keys.length === 0) return;
    const sourcePath = this.#runtime.databases.getProject(projectCode).sourcePaths[0];
    if (!sourcePath) return;
    try {
      const head = establishBaseline ? await gitHead(sourcePath) : null;
      for (const taskKey of keys) {
        let stored = await this.#runtime.databases.workItemEngineeringMetrics(projectCode, taskKey);
        if (!stored && head !== null) {
          stored = await this.#runtime.databases.ensureWorkItemEngineeringBaseline(
            projectCode,
            taskKey,
            head,
          );
        }
        if (!stored) continue;
        this.#scheduleWorkItemScan(projectCode, taskKey, sourcePath);
      }
    } catch {
      // Engineering metrics are observational and never roll back a committed task transition.
    }
  }
}

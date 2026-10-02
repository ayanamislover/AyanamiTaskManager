import type { AyanamiTaskService } from "@ayanami-task/application";
import { PROJECT_CODE_PATTERN } from "@ayanami-task/sync-protocol";

export type PublishSchedulerOptions = {
  service: AyanamiTaskService;
  /** 变化后等多久再发布。 */
  debounceMs: number;
  /** 持续变化时最多攒多久。 */
  maxDelayMs: number;
  /** 发布失败后多久重试。 */
  retryMs: number;
  /** 现在能不能发布（已连上且首次同步完成）。不能时只记下变化。 */
  ready(): boolean;
  /** 重建这些项目（顺带处理项目增删与 head）；失败抛错。 */
  publish(dirty: ReadonlySet<string>): Promise<void>;
  /** 发布失败时调用；返回 true 表示稍后重试。 */
  failed(error: unknown): boolean;
};

/**
 * 快照去抖：订阅进程内事件把项目标脏，1.5 s 去抖（最多攒 10 s）后只重建脏项目。
 * 没连上（包括默认的未启用）时只记一笔、不起计时器，连上后的首次同步会全量发布。
 */
export class PublishScheduler {
  readonly #options: PublishSchedulerOptions;
  readonly #dirty = new Set<string>();
  readonly #subscriptions = new Map<string, () => void>();
  #since: number | null = null;
  #timer: NodeJS.Timeout | null = null;
  #active = false;

  constructor(options: PublishSchedulerOptions) {
    this.#options = options;
  }

  activate(): void {
    this.#active = true;
  }

  /** 停止计时器、退订全部项目事件。 */
  stop(): void {
    this.#active = false;
    this.#clearTimer();
    for (const unsubscribe of this.#subscriptions.values()) unsubscribe();
    this.#subscriptions.clear();
  }

  /** `projectCode` 为 null 表示只影响项目列表或 head（例如全局事件、派单开关）。 */
  markDirty(projectCode: string | null): void {
    if (projectCode) this.#dirty.add(projectCode.toUpperCase());
    if (!this.#active || !this.#options.ready()) return;
    this.#since ??= Date.now();
    const waited = Date.now() - this.#since;
    const { debounceMs, maxDelayMs } = this.#options;
    this.#schedule(Math.max(0, Math.min(debounceMs, maxDelayMs - waited)));
  }

  /** 首次同步要全量发布：之前攒的变化作废，并按当前项目列表订阅事件。 */
  beginFullPublish(): void {
    this.#dirty.clear();
    this.#since = null;
    this.#syncSubscriptions();
  }

  /** 首次同步完成：期间只记了一笔的变化补一次去抖发布。 */
  afterFullPublish(): void {
    if (this.#dirty.size > 0) this.markDirty(null);
  }

  async flush(): Promise<void> {
    this.#clearTimer();
    if (!this.#active || !this.#options.ready()) return;
    this.#syncSubscriptions();
    const dirty = new Set(this.#dirty);
    this.#dirty.clear();
    this.#since = null;
    try {
      await this.#options.publish(dirty);
    } catch (error) {
      for (const code of dirty) this.#dirty.add(code);
      if (this.#options.failed(error)) this.#schedule(this.#options.retryMs);
    }
  }

  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(delay: number): void {
    this.#clearTimer();
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, delay);
    this.#timer.unref?.();
  }

  #syncSubscriptions(): void {
    if (!this.#active) return;
    const live = new Set(
      this.#options.service
        .listProjects()
        .filter((project) => project.lifecycle === "ACTIVE")
        .map((project) => project.code)
        .filter((code) => PROJECT_CODE_PATTERN.test(code)),
    );
    for (const [code, unsubscribe] of this.#subscriptions) {
      if (live.has(code)) continue;
      unsubscribe();
      this.#subscriptions.delete(code);
    }
    for (const code of live) {
      if (this.#subscriptions.has(code)) continue;
      const unsubscribe = this.#options.service.subscribeProject(code, () => this.markDirty(code));
      this.#subscriptions.set(code, unsubscribe);
    }
  }
}

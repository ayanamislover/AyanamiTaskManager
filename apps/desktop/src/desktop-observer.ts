import type { AyanamiTaskService } from "@ayanami-task/application";
import {
  normalizeNotificationMode,
  shouldNotify,
  type NotificationMode,
} from "./notification-policy.js";
import type { TraySnapshot } from "./host-protocol.js";

/**
 * 托盘计数与系统通知的事件订阅，常驻在 core（ATM-T-0539）。
 *
 * Electron 时代它挂在窗口宿主上，窗口只 hide 不销毁，所以一直活着。现在关窗会把整个 WebView
 * 销毁，界面相关的东西都跟着走——订阅、sequence 与去重不能跟着走，否则关窗后就再也收不到
 * 「任务受阻」的通知。core 只决定「发什么」，由宿主弹 toast、画菜单。
 */

type ProjectEvent = {
  seq: number;
  type: string;
  key: string | null;
  summary: string | null;
};

export type DesktopNotification = { title: string; body: string };

export type DesktopObserverOptions = {
  service: Pick<
    AyanamiTaskService,
    "overview" | "delta" | "subscribeProject" | "subscribeGlobal" | "globalDelta" | "setSetting"
  > & {
    databases: { getSetting<T>(key: string, fallback: T): { value: T } };
  };
  pendingUpdate(): string | null;
  notify(notification: DesktopNotification): void;
  trayChanged(snapshot: TraySnapshot): void;
  now?: () => number;
};

const PROJECT_EVENT_TITLES: Record<string, string> = {
  "work.waiting": "任务正在等待",
  "work.blocked": "任务受阻",
  "work.completed": "任务已完成",
  "agent.recovered_stale": "Agent 异常退出",
};
const PROJECT_DEDUP_MS = 10 * 60_000;
const DEDUP_RETENTION_MS = 60 * 60_000;

export class DesktopObserver {
  private unsubscribeGlobal: (() => void) | null = null;
  private readonly unsubscribeProjects = new Map<string, () => void>();
  private readonly projectSequences = new Map<string, number>();
  private readonly notificationDedup = new Map<string, number>();
  private lastSnapshot = "";
  private readonly now: () => number;

  constructor(private readonly options: DesktopObserverOptions) {
    this.now = options.now ?? Date.now;
  }

  notificationMode(): NotificationMode {
    const databases = this.options.service.databases;
    const mode = databases.getSetting<unknown>("notification.mode", null).value;
    const legacyEnabled = databases.getSetting<unknown>("notification.enabled", true).value;
    return normalizeNotificationMode(mode, legacyEnabled);
  }

  setNotificationMode(mode: NotificationMode): TraySnapshot {
    this.options.service.setSetting("notification.mode", mode);
    return this.refreshTray(true);
  }

  traySnapshot(): TraySnapshot {
    const overview = this.options.service.overview() as { projects?: unknown[] };
    const projects = (overview?.projects ?? []) as Array<Record<string, unknown>>;
    const sum = (field: string) =>
      projects.reduce((total, project) => total + (Number(project[field] ?? 0) || 0), 0);
    return {
      blocked: sum("blocked_count"),
      waiting: sum("waiting_user_count"),
      pendingUpdate: this.options.pendingUpdate(),
      notificationMode: this.notificationMode(),
    };
  }

  /** 快照没变就不推，避免每个事件都让宿主重建一次菜单。 */
  refreshTray(force = false): TraySnapshot {
    const snapshot = this.traySnapshot();
    const serialized = JSON.stringify(snapshot);
    if (force || serialized !== this.lastSnapshot) {
      this.lastSnapshot = serialized;
      this.options.trayChanged(snapshot);
    }
    return snapshot;
  }

  start(): void {
    this.ensureProjectSubscriptions();
    let sequence = Number(
      (this.options.service.overview() as { sequence?: unknown }).sequence ?? 0,
    );
    this.unsubscribeGlobal = this.options.service.subscribeGlobal(() => {
      const delta = this.options.service.globalDelta(sequence, 100);
      sequence = delta.nextSequence;
      for (const event of delta.events) {
        if (event.type !== "backup.failed" || !shouldNotify(this.notificationMode(), event.type))
          continue;
        const key = `global:${event.type}:${event.key}`;
        if (this.notificationDedup.has(key)) continue;
        this.notificationDedup.set(key, this.now());
        this.options.notify({ title: "备份失败", body: String(event.summary ?? "") });
      }
      this.ensureProjectSubscriptions();
      this.refreshTray();
    });
    this.refreshTray(true);
  }

  stop(): void {
    this.unsubscribeGlobal?.();
    this.unsubscribeGlobal = null;
    for (const unsubscribe of this.unsubscribeProjects.values()) unsubscribe();
    this.unsubscribeProjects.clear();
    this.projectSequences.clear();
  }

  private showProjectNotification(project: string, event: ProjectEvent): void {
    const title = PROJECT_EVENT_TITLES[event.type];
    if (!title || !shouldNotify(this.notificationMode(), event.type)) return;
    const key = `${project}:${event.type}:${event.key}`;
    const now = this.now();
    if ((this.notificationDedup.get(key) ?? 0) > now - PROJECT_DEDUP_MS) return;
    this.notificationDedup.set(key, now);
    for (const [candidate, at] of this.notificationDedup) {
      if (at < now - DEDUP_RETENTION_MS) this.notificationDedup.delete(candidate);
    }
    this.options.notify({
      title: `${project} · ${title}`,
      body: event.summary || event.key || title,
    });
  }

  private ensureProjectSubscriptions(): void {
    const overview = this.options.service.overview() as { projects?: unknown[] };
    const active = new Set<string>();
    for (const project of (overview.projects ?? []) as Array<Record<string, unknown>>) {
      if (project.lifecycle !== "ACTIVE") continue;
      const code = String(project.code);
      active.add(code);
      if (this.unsubscribeProjects.has(code)) continue;
      this.projectSequences.set(code, Number(project.project_sequence ?? 0));
      let running = false;
      let dirty = false;
      const consume = async () => {
        if (running) {
          dirty = true;
          return;
        }
        running = true;
        try {
          do {
            dirty = false;
            let delta;
            do {
              delta = await this.options.service.delta(
                code,
                this.projectSequences.get(code) ?? 0,
                100,
              );
              for (const event of delta.events as ProjectEvent[])
                this.showProjectNotification(code, event);
              const lastEvent = (delta.events as ProjectEvent[]).at(-1);
              if (lastEvent) this.projectSequences.set(code, lastEvent.seq);
            } while (delta.hasMore);
          } while (dirty);
        } finally {
          running = false;
          this.refreshTray();
        }
      };
      this.unsubscribeProjects.set(
        code,
        this.options.service.subscribeProject(code, () => void consume()),
      );
    }
    for (const [code, unsubscribe] of this.unsubscribeProjects) {
      if (!active.has(code)) {
        unsubscribe();
        this.unsubscribeProjects.delete(code);
        this.projectSequences.delete(code);
      }
    }
  }
}

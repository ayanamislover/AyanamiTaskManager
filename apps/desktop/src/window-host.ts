import { join } from "node:path";
import {
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification as ElectronNotification,
  shell,
  Tray,
} from "electron";
import type { AyanamiTaskService } from "@ayanami-task/application";
import {
  normalizeNotificationMode,
  notificationModes,
  shouldNotify,
  type NotificationMode,
} from "./notification-policy.js";
import { createWindowOptions } from "./window-options.js";

type ProjectEvent = {
  seq: number;
  type: string;
  key: string | null;
  summary: string | null;
};

export type WindowHostOptions = {
  service: AyanamiTaskService;
  applicationLogoPath: string;
  pendingUpdate(): string | null;
  quit(): void;
};

export class WindowHost {
  private mainWindow: BrowserWindow | null = null;
  private tray: Tray | null = null;
  private quitting = false;
  private unsubscribeGlobal: (() => void) | null = null;
  private readonly unsubscribeProjects = new Map<string, () => void>();
  private readonly projectSequences = new Map<string, number>();
  private readonly notificationDedup = new Map<string, number>();

  constructor(private readonly options: WindowHostOptions) {}

  get hasWindow(): boolean {
    return this.mainWindow !== null;
  }

  markQuitting(): void {
    this.quitting = true;
  }

  showWindow(): void {
    if (!this.mainWindow) return;
    if (this.mainWindow.isMinimized()) this.mainWindow.restore();
    this.mainWindow.show();
    this.mainWindow.focus();
  }

  createWindow(showWhenReady = true): void {
    this.mainWindow = new BrowserWindow(
      createWindowOptions(
        join(__dirname, "preload.cjs"),
        nativeTheme.shouldUseDarkColors,
        this.options.applicationLogoPath,
      ),
    );
    this.mainWindow.on("ready-to-show", () => {
      if (showWhenReady) this.showWindow();
    });
    const publishMaximizedState = () => {
      if (!this.mainWindow) return;
      this.mainWindow.webContents.send(
        "atm:window-maximized-changed",
        this.mainWindow.isMaximized(),
      );
    };
    this.mainWindow.on("maximize", publishMaximizedState);
    this.mainWindow.on("unmaximize", publishMaximizedState);
    this.mainWindow.on("close", (event) => {
      if (!this.quitting) {
        event.preventDefault();
        this.mainWindow?.hide();
      }
    });
    this.mainWindow.on("closed", () => {
      this.mainWindow = null;
    });
    if (process.env.ATM_RENDERER_URL) {
      void this.mainWindow.loadURL(process.env.ATM_RENDERER_URL);
    } else {
      void this.mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
    }
  }

  start(background: boolean): void {
    this.installWindowIpc();
    this.createTray();
    this.createWindow(!background);
    this.installDesktopEventObservers();
  }

  refreshTray(): void {
    this.tray?.setContextMenu(this.trayMenu());
  }

  notifyUpdateReady(releaseName: string): void {
    this.refreshTray();
    if (this.notificationMode() === "OFF" || !ElectronNotification.isSupported()) return;
    new ElectronNotification({
      title: "AyanamiTaskManager 已更新",
      body: `${releaseName} 已就绪，下次启动生效。`,
      icon: this.options.applicationLogoPath,
    }).show();
  }

  stopObservers(): void {
    this.unsubscribeGlobal?.();
    this.unsubscribeGlobal = null;
    for (const unsubscribe of this.unsubscribeProjects.values()) unsubscribe();
    this.unsubscribeProjects.clear();
    this.projectSequences.clear();
  }

  destroyTray(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  private installWindowIpc(): void {
    ipcMain.handle("atm:window-minimize", () => {
      this.mainWindow?.minimize();
    });
    ipcMain.handle("atm:window-toggle-maximize", () => {
      if (!this.mainWindow) return false;
      if (this.mainWindow.isMaximized()) this.mainWindow.unmaximize();
      else this.mainWindow.maximize();
      return this.mainWindow.isMaximized();
    });
    ipcMain.handle("atm:window-is-maximized", () => this.mainWindow?.isMaximized() ?? false);
    ipcMain.handle("atm:window-close", () => {
      this.mainWindow?.close();
    });
    ipcMain.handle("atm:show-item", (_event, path: string) => shell.showItemInFolder(path));
  }

  private navigate(route: string): void {
    this.showWindow();
    this.mainWindow?.webContents.send("atm:navigate", route);
  }

  private notificationMode(): NotificationMode {
    const mode = this.options.service.databases.getSetting<unknown>(
      "notification.mode",
      null,
    ).value;
    const legacyEnabled = this.options.service.databases.getSetting<unknown>(
      "notification.enabled",
      true,
    ).value;
    return normalizeNotificationMode(mode, legacyEnabled);
  }

  private trayMenu(): Menu {
    const overview = this.options.service.overview() as any;
    const projects = (overview?.projects ?? []) as any[];
    const blocked = projects.reduce((sum, project) => sum + Number(project.blocked_count ?? 0), 0);
    const waiting = projects.reduce(
      (sum, project) => sum + Number(project.waiting_user_count ?? 0),
      0,
    );
    const mode = this.notificationMode();
    const notificationLabels: Record<NotificationMode, string> = {
      ALL: "全部通知",
      CRITICAL: "仅严重事件",
      OFF: "不通知",
    };
    const pendingUpdate = this.options.pendingUpdate();
    return Menu.buildFromTemplate([
      { label: "打开绫波任务管理器", click: () => this.showWindow() },
      { label: "新建临时任务", click: () => this.navigate("quick") },
      { label: `受阻 ${blocked} / 等待用户 ${waiting}`, enabled: false },
      ...(pendingUpdate === null
        ? []
        : [{ label: `${pendingUpdate} 已就绪，重启生效`, enabled: false } as const]),
      { type: "separator" },
      {
        label: `系统通知 · ${notificationLabels[mode]}`,
        submenu: notificationModes.map((candidate) => ({
          label: notificationLabels[candidate],
          type: "radio" as const,
          checked: candidate === mode,
          click: () => {
            this.options.service.setSetting("notification.mode", candidate);
            this.refreshTray();
          },
        })),
      },
      { label: "设置", click: () => this.navigate("settings") },
      { type: "separator" },
      {
        label: "完全退出",
        click: () => {
          this.markQuitting();
          this.options.quit();
        },
      },
    ]);
  }

  private createTray(): void {
    const trayImage = nativeImage
      .createFromPath(this.options.applicationLogoPath)
      .resize({ width: 20, height: 20 });
    this.tray = new Tray(trayImage);
    this.tray.setToolTip("AyanamiTaskManager");
    this.refreshTray();
    this.tray.on("click", () => this.showWindow());
    this.tray.on("double-click", () => this.showWindow());
  }

  private showProjectNotification(project: string, event: ProjectEvent): void {
    const labels: Record<string, string> = {
      "work.waiting": "任务正在等待",
      "work.blocked": "任务受阻",
      "work.completed": "任务已完成",
      "agent.recovered_stale": "Agent 异常退出",
    };
    const title = labels[event.type];
    if (!title || !shouldNotify(this.notificationMode(), event.type)) return;
    const key = `${project}:${event.type}:${event.key}`;
    const now = Date.now();
    if ((this.notificationDedup.get(key) ?? 0) > now - 10 * 60_000) return;
    this.notificationDedup.set(key, now);
    for (const [candidate, at] of this.notificationDedup) {
      if (at < now - 60 * 60_000) this.notificationDedup.delete(candidate);
    }
    if (ElectronNotification.isSupported()) {
      new ElectronNotification({
        title: `${project} · ${title}`,
        body: event.summary || event.key || title,
        icon: this.options.applicationLogoPath,
      }).show();
    }
  }

  private ensureProjectSubscriptions(): void {
    const overview = this.options.service.overview() as any;
    const active = new Set<string>();
    for (const project of (overview.projects ?? []) as any[]) {
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
              for (const event of delta.events) this.showProjectNotification(code, event);
              const lastEvent = delta.events.at(-1);
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

  private installDesktopEventObservers(): void {
    this.ensureProjectSubscriptions();
    let sequence = Number((this.options.service.overview() as any).sequence ?? 0);
    this.unsubscribeGlobal = this.options.service.subscribeGlobal(() => {
      const delta = this.options.service.globalDelta(sequence, 100);
      sequence = delta.nextSequence;
      for (const event of delta.events) {
        if (
          event.type === "backup.failed" &&
          shouldNotify(this.notificationMode(), event.type) &&
          ElectronNotification.isSupported()
        ) {
          const key = `global:${event.type}:${event.key}`;
          if (!this.notificationDedup.has(key)) {
            this.notificationDedup.set(key, Date.now());
            new ElectronNotification({
              title: "备份失败",
              body: event.summary,
              icon: this.options.applicationLogoPath,
            }).show();
          }
        }
      }
      this.ensureProjectSubscriptions();
      this.refreshTray();
    });
  }
}

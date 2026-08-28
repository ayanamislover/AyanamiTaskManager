import { app, autoUpdater, ipcMain } from "electron";
import {
  classifyUpdateFailure,
  createUpdateDiagnostics,
  updateFeedDir,
  updateFeedReady,
  type UpdatePhase,
  type UpdateStatus,
} from "./updater.js";

export type UpdateHostOptions = {
  dataDir: string;
  smokeTrace(stage: string, detail?: unknown): void;
  onUpdateReady(releaseName: string): void;
};

export class UpdateHost {
  private feedConfigured = false;
  private downloaded: string | null = null;
  private phase: UpdatePhase = "CHECK";
  private readonly diagnostics;

  constructor(private readonly options: UpdateHostOptions) {
    this.diagnostics = createUpdateDiagnostics(options.dataDir);
  }

  get pendingUpdate(): string | null {
    return this.downloaded;
  }

  installIpc(): void {
    ipcMain.handle("atm:get-update-status", () => this.diagnostics.read());
    ipcMain.handle("atm:check-for-updates", () => this.check());
  }

  recordInstallFailure(detail: unknown): void {
    this.diagnostics.record({
      phase: "INSTALL",
      outcome: "ERROR",
      code: "INSTALL_FAILED",
      detail,
    });
  }

  check(): UpdateStatus | null {
    if (!app.isPackaged) return this.diagnostics.read();
    if (!updateFeedReady(this.options.dataDir)) {
      return this.diagnostics.record({
        phase: "CHECK",
        outcome: "SKIPPED",
        code: "UPDATE_SOURCE_MISSING",
        detail: "当前没有待安装的本地更新",
      });
    }
    this.phase = "CHECK";
    const checking = this.diagnostics.record({
      phase: "CHECK",
      outcome: "IN_PROGRESS",
      code: "CHECKING",
      detail: "正在检查本地更新",
    });
    try {
      if (!this.feedConfigured) {
        autoUpdater.setFeedURL({ url: updateFeedDir(this.options.dataDir) });
        this.feedConfigured = true;
      }
      autoUpdater.checkForUpdates();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const failure = classifyUpdateFailure(detail, this.phase);
      const status = this.diagnostics.record({ ...failure, outcome: "ERROR", detail });
      this.options.smokeTrace("update.check-failed", status);
      return status;
    }
    return checking;
  }

  start(): void {
    if (!app.isPackaged) return;
    autoUpdater.on("checking-for-update", () => {
      this.phase = "CHECK";
    });
    autoUpdater.on("update-available", () => {
      this.phase = "DOWNLOAD";
      this.diagnostics.record({
        phase: "DOWNLOAD",
        outcome: "IN_PROGRESS",
        code: "UPDATE_AVAILABLE",
        detail: "已发现新版本，正在下载并校验",
      });
    });
    autoUpdater.on("update-not-available", () => {
      this.phase = "READY";
      this.diagnostics.record({
        phase: "READY",
        outcome: "SUCCESS",
        code: "UP_TO_DATE",
        detail: "当前已是最新版本",
      });
    });
    autoUpdater.on("error", (error: Error) => {
      const failure = classifyUpdateFailure(error, this.phase);
      const status = this.diagnostics.record({
        ...failure,
        outcome: "ERROR",
        detail: error,
      });
      this.options.smokeTrace("update.error", status);
    });
    autoUpdater.on("update-downloaded", (_event, _notes, releaseName: string) => {
      this.downloaded = releaseName;
      this.phase = "READY";
      const status = this.diagnostics.record({
        phase: "READY",
        outcome: "SUCCESS",
        code: "UPDATE_READY",
        detail: `${releaseName} 已就绪，下次启动生效`,
        version: releaseName,
      });
      this.options.smokeTrace("update.downloaded", status);
      this.options.onUpdateReady(releaseName);
    });
    this.check();
    const timer = setInterval(() => this.check(), 6 * 60 * 60 * 1000);
    timer.unref();
  }
}

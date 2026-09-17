import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { app, autoUpdater, ipcMain } from "electron";
import {
  classifyUpdateFailure,
  createUpdateDiagnostics,
  electronUpdateExe,
  parseSquirrelCheck,
  planUpdateCheck,
  pruneConsumedUpdateFeed,
  resolveUpdateExe,
  updateFeedDir,
  updateFeedReady,
  type UpdatePhase,
  type UpdateStatus,
} from "./updater.js";

export type UpdateExeResult = { code: number | null; output: string };
export type UpdateExeRunner = (updateExe: string, args: string[]) => Promise<UpdateExeResult>;

export type UpdateHostOptions = {
  dataDir: string;
  smokeTrace(stage: string, detail?: unknown): void;
  onUpdateReady(releaseName: string): void;
  /** 注入点：测试用假的 Update.exe，生产走真正的子进程。 */
  runUpdateExe?: UpdateExeRunner;
  execPath?: string;
  appVersion?: () => string;
  exists?: (path: string) => boolean;
};

const runUpdateExeProcess: UpdateExeRunner = (updateExe, args) =>
  new Promise((resolve) => {
    const child = spawn(updateExe, args, { windowsHide: true });
    let output = "";
    const append = (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-8192);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (error) => resolve({ code: null, output: `${output}\n${error.message}` }));
    child.on("close", (code) => resolve({ code, output }));
  });

export class UpdateHost {
  private feedConfigured = false;
  private downloaded: string | null = null;
  private phase: UpdatePhase = "CHECK";
  private checking: Promise<UpdateStatus | null> | null = null;
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

  /** 同一时刻只跑一次检查：6 小时的定时器和用户手点可能撞在一起。 */
  check(): Promise<UpdateStatus | null> {
    if (this.checking) return this.checking;
    const pending = this.runCheck().finally(() => {
      if (this.checking === pending) this.checking = null;
    });
    this.checking = pending;
    return pending;
  }

  private async runCheck(): Promise<UpdateStatus | null> {
    if (!app.isPackaged) return this.diagnostics.read();
    const dataDir = this.options.dataDir;
    const execPath = this.options.execPath ?? process.execPath;
    const version = (this.options.appVersion ?? (() => app.getVersion()))();
    const exists = this.options.exists ?? existsSync;
    const plan = planUpdateCheck({
      consumed: pruneConsumedUpdateFeed(dataDir, version),
      feedReady: updateFeedReady(dataDir),
      electronRunnerReady: exists(electronUpdateExe(execPath)),
      resolvedUpdateExe: resolveUpdateExe(execPath, realpathSync, exists),
    });
    if (plan.kind === "SKIP") {
      return this.diagnostics.record({
        phase: "CHECK",
        outcome: "SKIPPED",
        code: plan.code,
        detail: plan.detail,
      });
    }
    this.phase = "CHECK";
    const checking = this.diagnostics.record({
      phase: "CHECK",
      outcome: "IN_PROGRESS",
      code: "CHECKING",
      detail: "正在检查本地更新",
    });
    if (plan.kind === "SQUIRREL") return this.applyWithSquirrel(plan.updateExe);
    try {
      if (!this.feedConfigured) {
        autoUpdater.setFeedURL({ url: updateFeedDir(dataDir) });
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

  /**
   * 自己驱动 Squirrel：`--checkForUpdate` 只读，最后一行是 JSON；有要装的版本才
   * 继续 `--update`。应用通过 current 链接启动时 Electron 的 autoUpdater 找不到
   * Update.exe，这条路让本地更新仍然可用，而不是每次都记一条安装失败。
   */
  private async applyWithSquirrel(updateExe: string): Promise<UpdateStatus | null> {
    const run = this.options.runUpdateExe ?? runUpdateExeProcess;
    const feed = updateFeedDir(this.options.dataDir);
    const checked = await run(updateExe, [`--checkForUpdate=${feed}`]);
    const available = parseSquirrelCheck(checked.output);
    if (checked.code !== 0 || !available) {
      const detail = checked.output || `Update.exe exit ${checked.code ?? "unknown"}`;
      const failure = classifyUpdateFailure(detail, "CHECK");
      const status = this.diagnostics.record({ ...failure, outcome: "ERROR", detail });
      this.options.smokeTrace("update.check-failed", status);
      return status;
    }
    if (available.releasesToApply.length === 0) {
      this.phase = "READY";
      return this.diagnostics.record({
        phase: "READY",
        outcome: "SUCCESS",
        code: "UP_TO_DATE",
        detail: "当前已是最新版本",
      });
    }
    this.phase = "DOWNLOAD";
    this.diagnostics.record({
      phase: "DOWNLOAD",
      outcome: "IN_PROGRESS",
      code: "UPDATE_AVAILABLE",
      detail: `已发现 ${available.futureVersion}，正在下载并校验`,
      version: available.futureVersion,
    });
    const applied = await run(updateExe, [`--update=${feed}`]);
    if (applied.code !== 0) {
      const detail = applied.output || `Update.exe exit ${applied.code ?? "unknown"}`;
      const failure = classifyUpdateFailure(detail, "INSTALL");
      const status = this.diagnostics.record({ ...failure, outcome: "ERROR", detail });
      this.options.smokeTrace("update.error", status);
      return status;
    }
    this.downloaded = available.futureVersion;
    this.phase = "READY";
    const status = this.diagnostics.record({
      phase: "READY",
      outcome: "SUCCESS",
      code: "UPDATE_READY",
      detail: `${available.futureVersion} 已就绪，下次启动生效`,
      version: available.futureVersion,
    });
    this.options.smokeTrace("update.downloaded", status);
    this.options.onUpdateReady(available.futureVersion);
    return status;
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
    void this.check();
    const timer = setInterval(() => void this.check(), 6 * 60 * 60 * 1000);
    timer.unref();
  }
}

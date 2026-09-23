import { app } from "electron";
import { prefetchSelfProcessIdentity } from "@ayanami-task/daemon";
import { installAgentIntegrationHost } from "./main-agent-integrations.js";
import {
  applicationLogoPath,
  dataDirBeforeReady,
  installRuntimeIpc,
  runHeadlessModes,
  smokeTrace,
  startRuntimeHost,
  type RuntimeHost,
} from "./runtime-host.js";
import { handleSquirrelStartup } from "./squirrel.js";
import {
  isAgentWakeRequest,
  randomStartupDelayMs,
  shouldDelayStartup,
  shouldStartInBackground,
  waitForStartupDelay,
} from "./startup.js";
import { UpdateHost } from "./update-host.js";
import { WindowHost } from "./window-host.js";
import { createLifecycleDiagnostics, lifecycleError } from "./lifecycle-diagnostics.js";

const lifecycle = createLifecycleDiagnostics(dataDirBeforeReady(), app.getVersion());
// Monitor only: adding an uncaughtException/unhandledRejection handler would change
// Node's fatal-error semantics and could leave a damaged process alive.
process.on("uncaughtExceptionMonitor", (error, origin) => {
  lifecycle.record("exception", { ...lifecycleError(error), origin });
});
process.on("exit", (code) => lifecycle.finish(code, cleanShutdown && code === 0));
app.on("quit", (_event, code) => lifecycle.finish(code, cleanShutdown && code === 0));
app.on("child-process-gone", (_event, details) => {
  lifecycle.record("child.gone", {
    reason: details.reason,
    exitCode: details.exitCode,
    processType: details.type,
  });
});
app.on("web-contents-created", (_event, contents) => {
  contents.on("render-process-gone", (_goneEvent, details) => {
    lifecycle.record("renderer.gone", { reason: details.reason, exitCode: details.exitCode });
  });
  contents.on("did-fail-load", (_loadEvent, code, _description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) lifecycle.record("renderer.load-failed", { exitCode: code });
  });
});

let runtimeHost: RuntimeHost | null = null;
let windowHost: WindowHost | null = null;
let maintenanceTimer: NodeJS.Timeout | null = null;
let initialMaintenanceTimer: NodeJS.Timeout | null = null;
let lifecycleTimer: NodeJS.Timeout | null = null;
let shutdownStarted = false;
let shutdownComplete = false;
let cleanShutdown = false;
const updateHost = new UpdateHost({
  dataDir: dataDirBeforeReady(),
  smokeTrace,
  onUpdateReady: (releaseName) => windowHost?.notifyUpdateReady(releaseName),
});

async function startApplication(background: boolean): Promise<void> {
  runtimeHost = await startRuntimeHost();
  const { dataDir, runtime, service } = runtimeHost;
  installRuntimeIpc(runtimeHost);
  updateHost.installIpc();

  installAgentIntegrationHost({
    service,
    runtime,
    dataDir,
    execPath: process.execPath,
    packaged: app.isPackaged,
    smokeTrace,
  });

  windowHost = new WindowHost({
    service,
    applicationLogoPath: applicationLogoPath(),
    pendingUpdate: () => updateHost.pendingUpdate,
    quit: () => app.quit(),
  });
  initialMaintenanceTimer = setTimeout(() => {
    void service.runMaintenance();
  }, 2500);
  maintenanceTimer = setInterval(
    () => {
      void service.runMaintenance();
    },
    60 * 60 * 1000,
  );
  maintenanceTimer.unref();
  windowHost.start(background);
  updateHost.start();
  lifecycle.record("ready");
  lifecycleTimer = setInterval(() => {
    const memory = process.memoryUsage();
    lifecycle.record("heartbeat", { rss: memory.rss, heapUsed: memory.heapUsed });
  }, 60_000);
  lifecycleTimer.unref();
}

async function bootstrap(): Promise<void> {
  if (
    handleSquirrelStartup(process.argv, process.execPath, undefined, (detail) =>
      updateHost.recordInstallFailure(detail),
    )
  ) {
    app.quit();
    return;
  }
  const args = process.argv.slice(1);
  smokeTrace("bootstrap", { argv: process.argv, args });
  if (await runHeadlessModes(args)) {
    app.exit(0);
    return;
  }
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  lifecycle.start({
    background: shouldStartInBackground(args, false),
    agentWake: isAgentWakeRequest(args),
  });
  // 锁文件要记自身进程的出生时间，而取它是一次 spawnSync(powershell.exe)（实测 p50 约
  // 175ms）。那一步在 startApplication 里同步发生，窗口显示排在它后面。这里先把它踢出去，
  // 让它和下面的 whenReady、随机登录延迟重叠；没赶上也只是退回原来的同步路径。
  void prefetchSelfProcessIdentity();
  let foregroundRequested = false;
  const startupDelayController = new AbortController();
  app.on("second-instance", (_event, commandLine) => {
    if (
      (process.env.ATM_PACKAGED_SMOKE === "1" || process.env.ATM_STARTUP_SMOKE === "1") &&
      commandLine.includes("--smoke-quit")
    ) {
      windowHost?.markQuitting();
      startupDelayController.abort();
      app.quit();
      return;
    }
    if (isAgentWakeRequest(commandLine)) {
      // An MCP/CLI wake-up cancels randomized login delay but remains hidden.
      startupDelayController.abort();
      return;
    }
    foregroundRequested = true;
    startupDelayController.abort();
    windowHost?.showWindow();
  });
  await app.whenReady();
  if (shouldDelayStartup(args, process.env.ATM_PACKAGED_SMOKE === "1")) {
    await waitForStartupDelay(randomStartupDelayMs(), startupDelayController.signal);
  }
  await startApplication(shouldStartInBackground(args, foregroundRequested));
  app.on("activate", () => {
    if (!windowHost?.hasWindow) windowHost?.createWindow(true);
    else windowHost.showWindow();
  });
}

async function shutdown(): Promise<void> {
  if (lifecycleTimer) clearInterval(lifecycleTimer);
  lifecycleTimer = null;
  if (initialMaintenanceTimer) clearTimeout(initialMaintenanceTimer);
  if (maintenanceTimer) clearInterval(maintenanceTimer);
  initialMaintenanceTimer = null;
  maintenanceTimer = null;
  windowHost?.stopObservers();
  if (runtimeHost) await runtimeHost.close();
  runtimeHost = null;
  cleanShutdown = true;
}

app.on("before-quit", (event) => {
  windowHost?.markQuitting();
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  lifecycle.record("shutdown.begin");
  void shutdown().finally(() => {
    shutdownComplete = true;
    lifecycle.record(cleanShutdown ? "shutdown.complete" : "shutdown.failed");
    app.quit();
  });
});
app.on("window-all-closed", () => {});
app.on("will-quit", () => {
  windowHost?.destroyTray();
  windowHost = null;
});

void bootstrap().catch((error) => {
  lifecycle.record("bootstrap.failed", lifecycleError(error));
  smokeTrace(
    "bootstrap.error",
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  app.exit(1);
});

import { app } from "electron";
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

let runtimeHost: RuntimeHost | null = null;
let windowHost: WindowHost | null = null;
let maintenanceTimer: NodeJS.Timeout | null = null;
let initialMaintenanceTimer: NodeJS.Timeout | null = null;
let shutdownStarted = false;
let shutdownComplete = false;
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
  if (initialMaintenanceTimer) clearTimeout(initialMaintenanceTimer);
  if (maintenanceTimer) clearInterval(maintenanceTimer);
  initialMaintenanceTimer = null;
  maintenanceTimer = null;
  windowHost?.stopObservers();
  if (runtimeHost) await runtimeHost.close();
  runtimeHost = null;
}

app.on("before-quit", (event) => {
  windowHost?.markQuitting();
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  void shutdown().finally(() => {
    shutdownComplete = true;
    app.quit();
  });
});
app.on("window-all-closed", () => {});
app.on("will-quit", () => {
  windowHost?.destroyTray();
  windowHost = null;
});

void bootstrap().catch((error) => {
  smokeTrace(
    "bootstrap.error",
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  app.exit(1);
});

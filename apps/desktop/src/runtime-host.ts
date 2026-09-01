import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, ipcMain } from "electron";
import { AyanamiTaskService } from "@ayanami-task/application";
import { AyanamiClient } from "@ayanami-task/client";
import { createCliProgram } from "@ayanami-task/cli";
import {
  buildAyanamiServer,
  acquireDaemonRuntime,
  createDaemonToken,
  DAEMON_VERSION,
  readDaemonRuntime,
  resolveDaemonDataDirectory,
  type DaemonRuntimeDescriptor,
} from "@ayanami-task/daemon";
import { runStdioMcpProxy } from "@ayanami-task/mcp";
import { installAgentDocumentation } from "./agent-documentation.js";
import {
  installMcpRuntimeLink,
  installMcpStdioBridge,
  mcpStdioHttpPath,
  shouldManageMcpRuntime,
} from "./mcp-launch.js";
import { LOGIN_ITEM_ARGS, loginItemExecutable } from "./startup.js";
import { proxyRuntimeRequest, type RuntimeRequestInput } from "./runtime-request.js";

export type Runtime = DaemonRuntimeDescriptor;

export type RuntimeHost = {
  dataDir: string;
  runtimeDir: string;
  runtime: Runtime;
  service: AyanamiTaskService;
  close(): Promise<void>;
};

export function dataDirBeforeReady(): string {
  return resolveDaemonDataDirectory();
}

export function readRuntime(): Runtime {
  return readDaemonRuntime(join(dataDirBeforeReady(), "runtime"));
}

export function smokeTrace(stage: string, detail: unknown = null): void {
  if (process.env.ATM_PACKAGED_SMOKE !== "1") return;
  const runtimeDir = join(dataDirBeforeReady(), "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  appendFileSync(
    join(runtimeDir, "headless-smoke.ndjson"),
    `${JSON.stringify({ stage, detail, at: new Date().toISOString() })}\n`,
    "utf8",
  );
}

export async function runHeadlessModes(args: string[]): Promise<boolean> {
  if (args.includes("--mcp-stdio")) {
    smokeTrace("mcp-stdio.start", { argv: process.argv });
    const current = readRuntime();
    await runStdioMcpProxy({
      endpoint: `${current.endpoint.replace(/\/$/u, "")}${mcpStdioHttpPath(args)}`,
      token: current.token,
    });
    smokeTrace("mcp-stdio.end");
    return true;
  }
  if (args.includes("--doctor")) {
    const current = readRuntime();
    process.stdout.write(`${JSON.stringify(await new AyanamiClient(current).doctor())}\n`);
    return true;
  }
  const cliIndex = args.indexOf("--cli");
  if (cliIndex >= 0) {
    await createCliProgram().parseAsync(["node", "atm", ...args.slice(cliIndex + 1)]);
    return true;
  }
  return false;
}

export function applicationLogoPath(): string {
  // Electron resolves app.asar paths through its virtual filesystem. Keeping
  // this path under app.getAppPath() seals the production PNG into app.asar;
  // no standalone logo file is placed beside the executable or resources.
  return join(app.getAppPath(), "logo.png");
}

function bundledDocumentationRoot(): string {
  return app.isPackaged ? process.resourcesPath : app.getAppPath();
}

function bundledMcpStdioPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "mcp-stdio.cjs")
    : join(app.getAppPath(), "apps", "desktop", "resources", "mcp-stdio.cjs");
}

export async function startRuntimeHost(): Promise<RuntimeHost> {
  const dataDir = dataDirBeforeReady();
  if (shouldManageMcpRuntime(app.isPackaged)) {
    installAgentDocumentation(bundledDocumentationRoot(), dataDir);
    installMcpStdioBridge(bundledMcpStdioPath(), dataDir);
    installMcpRuntimeLink(process.execPath, dataDir);
  }
  const runtimeDir = join(dataDir, "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  const lease = acquireDaemonRuntime(runtimeDir);
  // The production desktop must rotate credentials on every host start. The
  // standalone daemon keeps an explicit development override, but inherited
  // environment cannot pin an installed desktop token across restarts.
  const token = createDaemonToken({});
  let service: AyanamiTaskService | null = null;
  let server: Awaited<ReturnType<typeof buildAyanamiServer>> | null = null;
  try {
    service = await AyanamiTaskService.open({
      dataDir,
      migrationsRoot: join(app.getAppPath(), "migrations"),
    });
    server = await buildAyanamiServer({ service, token });
    await server.listen({ host: "127.0.0.1", port: 0 });
  } catch (error) {
    if (server) await server.close().catch(() => undefined);
    service?.close();
    lease.release();
    throw error;
  }
  const address = server.server.address();
  if (!address || typeof address === "string") {
    await server.close();
    service.close();
    lease.release();
    throw new Error("DAEMON_TCP_ADDRESS_MISSING");
  }
  const runtime: Runtime = {
    endpoint: `http://127.0.0.1:${address.port}`,
    token,
    pid: process.pid,
    instanceId: lease.instanceId,
    version: DAEMON_VERSION,
    startedAt: new Date().toISOString(),
  };
  lease.publish(runtime);
  let closed = false;
  return {
    dataDir,
    runtimeDir,
    runtime,
    service,
    async close() {
      if (closed) return;
      closed = true;
      await server.close();
      service.close();
      lease.clear();
      lease.release();
    },
  };
}

function autoLaunchEnabled(dataDir: string): boolean {
  return app.getLoginItemSettings({
    path: loginItemExecutable(dataDir),
    args: [...LOGIN_ITEM_ARGS],
  }).openAtLogin;
}

function setAutoLaunch(dataDir: string, enabled: boolean): boolean {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: loginItemExecutable(dataDir),
    args: [...LOGIN_ITEM_ARGS],
  });
  return autoLaunchEnabled(dataDir);
}

export function installRuntimeIpc(host: RuntimeHost): void {
  if (process.env.ATM_PACKAGED_SMOKE === "1") {
    const original = autoLaunchEnabled(host.dataDir);
    const toggled = setAutoLaunch(host.dataDir, !original);
    const restored = setAutoLaunch(host.dataDir, original);
    writeFileSync(
      join(host.runtimeDir, "autolaunch-smoke.json"),
      JSON.stringify({
        original,
        toggled,
        restored,
        path: loginItemExecutable(host.dataDir),
        args: [...LOGIN_ITEM_ARGS],
        passed: toggled === !original && restored === original,
      }),
      "utf8",
    );
  }
  ipcMain.handle("atm:runtime-request", (_event, input: RuntimeRequestInput) =>
    proxyRuntimeRequest(host.runtime, input),
  );
  ipcMain.handle("atm:get-auto-launch", () => autoLaunchEnabled(host.dataDir));
  ipcMain.handle("atm:set-auto-launch", (_event, enabled: boolean) =>
    setAutoLaunch(host.dataDir, enabled),
  );
}

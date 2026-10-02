import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AyanamiTaskService } from "@ayanami-task/application";
import {
  acquireDaemonRuntime,
  buildAyanamiServer,
  createDaemonToken,
  DAEMON_VERSION,
  configureProcessIdentityHelper,
  prefetchSelfProcessIdentity,
  resolveDaemonDataDirectory,
  type DaemonRuntimeDescriptor,
} from "@ayanami-task/daemon";
import { installAgentDocumentation } from "./agent-documentation.js";
import {
  packagedCorePaths,
  packagedLayoutPresent,
  sourceCorePaths,
  type CorePaths,
} from "./core-paths.js";
import { startMobileFeatures, type MobileFeatures } from "./core-mobile.js";
import { DesktopObserver } from "./desktop-observer.js";
import { HostControlSession } from "./host-control-session.js";
import { HOST_PROTOCOL_VERSION, type HostHello } from "./host-protocol.js";
import { probeDataRoot, probeTransactionBound } from "./core-probe.js";
import { createLifecycleDiagnostics, lifecycleError } from "./lifecycle-diagnostics.js";
import { WindowMemoryRelease } from "./window-memory-release.js";
import { installAgentIntegrationHost } from "./main-agent-integrations.js";
import { installMcpStdioBridge, shouldManageMcpRuntime } from "./mcp-launch.js";
import { normalizeNotificationMode } from "./notification-policy.js";
import { isTrustedHostParent, queryParentIdentity } from "./parent-identity.js";
import { injectFetch, type InjectableServer } from "./inject-fetch.js";
import { parseRuntimeRequestInput, proxyRuntimeRequest } from "./runtime-request.js";
import { installRootOf, UpdateCoordinator } from "./update-coordinator.js";

/**
 * core 进程入口（打包为 runtime\core.mjs，由宿主以 atm-core.exe 启动）。
 *
 * 只有一种运行方式：host-control。CLI、doctor、MCP stdio 是别的入口文件，这里没有用户代理
 * 以外的模式可切换（de-electron §4）。stdout 只写协议帧——所以最先把 console 全部改到 stderr，
 * 任何一个依赖顺手 console.log 都会把协议流写坏。
 */

declare const __ATM_PACKAGED__: boolean | undefined;
const PACKAGED = typeof __ATM_PACKAGED__ === "boolean" && __ATM_PACKAGED__;
/** 握手失败、父进程不可信：退出码固定，宿主据此区分「被拒绝」与「崩溃」。 */
export const CORE_EXIT_REJECTED = 64;

/** 关窗后多久释放界面用过的内存（等界面最后的请求落地）。 */
const WINDOW_CLOSED_RELEASE_MS = 5_000;

/** 心跳与开关窗时的内存分项：区分 V8 堆、ArrayBuffer 与其余堆外（SQLite、原生分配）。 */
function memoryDetail() {
  const memory = process.memoryUsage();
  return {
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    heapTotal: memory.heapTotal,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
  };
}

function redirectConsoleToStderr(): void {
  const write = (...values: unknown[]) => {
    const text = values
      .map((value) => (typeof value === "string" ? value : String(value)))
      .join(" ")
      .slice(0, 4000);
    process.stderr.write(`${text}\n`);
  };
  console.log = write;
  console.info = write;
  console.debug = write;
  console.warn = write;
}

function resolvePaths(): CorePaths {
  const bundleFile = fileURLToPath(import.meta.url);
  if (PACKAGED) return packagedCorePaths(bundleFile);
  const repositoryRoot = resolve(process.env.ATM_DEV_REPOSITORY_ROOT ?? process.cwd());
  const hostPath = process.env.ATM_DEV_HOST_PATH;
  if (!hostPath) throw new Error("ATM_DEV_HOST_PATH_REQUIRED: 源码运行 core 需要声明本地宿主路径");
  return sourceCorePaths(repositoryRoot, resolve(hostPath));
}

type CoreRuntime = {
  descriptor: DaemonRuntimeDescriptor;
  userToken: string;
  server: InjectableServer;
  service: AyanamiTaskService;
  close(): Promise<void>;
};

async function startRuntime(paths: CorePaths, dataDir: string): Promise<CoreRuntime> {
  if (shouldManageMcpRuntime(paths.packaged)) {
    installAgentDocumentation(paths.documentationRoot, dataDir);
    installMcpStdioBridge(paths.mcpStdioSource, dataDir);
  }
  const runtimeDir = join(dataDir, "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  const lease = acquireDaemonRuntime(runtimeDir);
  // 打包版每次启动都换两份凭证；继承来的环境变量不能把它们钉住（ATM-T-0503）。
  const token = createDaemonToken({});
  const userToken = createDaemonToken({});
  const startedAt = new Date().toISOString();
  let service: AyanamiTaskService | null = null;
  let server: Awaited<ReturnType<typeof buildAyanamiServer>> | null = null;
  let mobile: MobileFeatures | null = null;
  try {
    service = await AyanamiTaskService.open({ dataDir, migrationsRoot: paths.migrationsRoot });
    // 手机同步与派单在后台起来（core-mobile.ts）：DPAPI 自检、派单恢复不占与宿主握手的时间。
    mobile = startMobileFeatures({ service, dataDir, hostPath: paths.hostPath });
    server = await buildAyanamiServer({
      service,
      token,
      userToken,
      startedAt,
      sync: mobile.sync,
      dispatch: mobile.dispatch,
    });
    await server.listen({ host: "127.0.0.1", port: 0 });
  } catch (error) {
    if (server) await server.close().catch(() => undefined);
    await mobile?.close();
    service?.close();
    lease.release();
    throw error;
  }
  const address = server.server.address();
  if (!address || typeof address === "string") {
    await server.close().catch(() => undefined);
    await mobile.close();
    service.close();
    lease.release();
    throw new Error("DAEMON_TCP_ADDRESS_MISSING");
  }
  const descriptor: DaemonRuntimeDescriptor = {
    endpoint: `http://127.0.0.1:${address.port}`,
    token,
    pid: process.pid,
    instanceId: lease.instanceId,
    version: DAEMON_VERSION,
    startedAt,
  };
  lease.publish(descriptor);
  let closed = false;
  const openService = service;
  const openServer = server;
  const openMobile = mobile;
  return {
    descriptor,
    userToken,
    server: openServer as unknown as InjectableServer,
    service: openService,
    async close() {
      if (closed) return;
      closed = true;
      // 手机功能与 HTTP 服务同时收尾：前者有总时长上限（core-mobile.ts），整体留在宿主的退出宽限内；
      // 任何一步出错，后面的关库与发现文件清理照样做。
      const mobileClosed = openMobile.close();
      try {
        await openServer.close();
      } finally {
        await mobileClosed;
        openService.close();
        lease.clear();
        lease.release();
      }
    },
  };
}

async function main(): Promise<void> {
  redirectConsoleToStderr();
  const paths = resolvePaths();
  if (paths.packaged && !packagedLayoutPresent(paths)) {
    process.stderr.write("ATM_CORE_LAYOUT_INVALID\n");
    process.exit(CORE_EXIT_REJECTED);
  }
  const dataDir = resolveDaemonDataDirectory();
  const lifecycle = createLifecycleDiagnostics(dataDir, DAEMON_VERSION, { name: "lifecycle-core" });
  process.on("uncaughtExceptionMonitor", (error, origin) => {
    lifecycle.record("exception", { ...lifecycleError(error), origin });
  });
  const selfStartedAtMs = Date.now() - Math.round(process.uptime() * 1000);
  // 父进程身份查询要起一次 PowerShell（约 175 ms），先踢出去，和等握手重叠。
  // 两次查询都交给本版本目录里的宿主（--process-identity），不再各起一个 PowerShell。
  configureProcessIdentityHelper(paths.hostPath);
  const parentQuery = queryParentIdentity(process.ppid, paths.hostPath);
  void prefetchSelfProcessIdentity();

  let runtime: CoreRuntime | null = null;
  const windowMemory = new WindowMemoryRelease({
    delayMs: WINDOW_CLOSED_RELEASE_MS,
    release: () => {
      if (shuttingDown) return;
      try {
        runtime?.service.databases.releaseMemory();
        // 界面那批请求留下的 V8 堆空间也只有完整 GC 才还（宿主给 core 加了 --expose-gc）。
        (globalThis as { gc?: () => void }).gc?.();
        lifecycle.record("window.released", memoryDetail());
      } catch (error) {
        // 释放失败只是少还了内存：连接照常可用，下次维护还会关空闲库。
        lifecycle.record("exception", { reason: "memory-release", ...lifecycleError(error) });
      }
    },
  });
  let observer: DesktopObserver | null = null;
  let maintenance: NodeJS.Timeout | null = null;
  let initialMaintenance: NodeJS.Timeout | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let updates: UpdateCoordinator | null = null;
  let shuttingDown = false;
  /** 只读探测已回过 probed：之后宿主断管是正常结束，不是握手被拒。 */
  let probed = false;

  const shutdown = async (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    lifecycle.record("shutdown.begin");
    if (heartbeat) clearInterval(heartbeat);
    windowMemory.cancel();
    if (initialMaintenance) clearTimeout(initialMaintenance);
    if (maintenance) clearInterval(maintenance);
    updates?.stop();
    observer?.stop();
    let clean = code === 0;
    try {
      await runtime?.close();
    } catch {
      clean = false;
    }
    lifecycle.record(clean ? "shutdown.complete" : "shutdown.failed");
    lifecycle.finish(code, clean);
    process.exit(code);
  };

  const session = new HostControlSession({
    input: process.stdin,
    output: process.stdout,
    async onHello(hello: HostHello) {
      // 源码运行时宿主路径来自开发者声明，只在非打包构建里存在；打包版必须是本版本目录里的宿主。
      const parent = await parentQuery;
      if (!isTrustedHostParent(parent, paths.hostPath, selfStartedAtMs)) {
        process.stderr.write(
          `ATM_CORE_HOST_UNTRUSTED ${parent ? "parent-mismatch" : "parent-unknown"}\n`,
        );
        throw new Error("HOST_PARENT_UNTRUSTED");
      }
      if (hello.probe) {
        // 安装事务的只读探测：不写日志、不开服务、不取 lease、不 listen、不发布 daemon.json。
        if (!paths.packaged || !probeTransactionBound(paths.appDir, hello.probe.txn)) {
          process.stderr.write("ATM_CORE_PROBE_UNBOUND\n");
          throw new Error("PROBE_UNBOUND");
        }
        session.send({ t: "probed", ...probeDataRoot(dataDir, paths.migrationsRoot) });
        probed = true;
        return;
      }
      lifecycle.start({ background: hello.launch.background, agentWake: hello.launch.agentWake });
      try {
        runtime = await startRuntime(paths, dataDir);
      } catch (error) {
        // 服务起不来（锁被占、数据库打不开）不是握手被拒：告诉宿主原因，按失败退出。
        const detail = lifecycleError(error);
        lifecycle.record("bootstrap.failed", detail);
        lifecycle.finish(1, false);
        session.send({
          t: "fatal",
          code: typeof detail.errorCode === "string" ? detail.errorCode : "CORE_START_FAILED",
          message: error instanceof Error ? error.message.slice(0, 2000) : String(error),
        });
        process.stdout.write("", () => process.exit(1));
        return new Promise<never>(() => undefined);
      }
      const current = runtime;
      const userFetch = injectFetch(current.server);
      session.handle("runtimeRequest", (input) =>
        proxyRuntimeRequest(
          { endpoint: current.descriptor.endpoint, token: current.userToken },
          parseRuntimeRequestInput(input),
          userFetch,
        ),
      );
      observer = new DesktopObserver({
        service: current.service,
        pendingUpdate: () => updates?.pendingUpdate ?? null,
        notify: (notification) => session.send({ t: "notify", ...notification }),
        trayChanged: (snapshot) => session.send({ t: "tray", snapshot }),
      });
      const activeObserver = observer;
      const activeUpdates = new UpdateCoordinator({
        dataDir,
        currentVersion: DAEMON_VERSION,
        installRoot: installRootOf(paths.appDir, paths.packaged),
        requestInstall: (manifest) => session.send({ t: "install-update", manifest }),
        onUpdateReady: (version) => {
          activeObserver.refreshTray();
          if (activeObserver.notificationMode() !== "OFF")
            session.send({
              t: "notify",
              title: "AyanamiTaskManager 有新版本",
              body: `${version} 已就绪，在托盘或设置里点「立即更新」。`,
            });
        },
      });
      updates = activeUpdates;
      session.handle("getUpdateStatus", () => activeUpdates.status());
      session.handle("checkForUpdates", () => activeUpdates.check());
      session.handle("applyUpdate", () => activeUpdates.apply());
      session.handle("setNotificationMode", (mode) => {
        const normalized = normalizeNotificationMode(mode, true);
        if (normalized !== mode) throw new Error("NOTIFICATION_MODE_INVALID");
        return activeObserver.setNotificationMode(normalized);
      });
      installAgentIntegrationHost({
        service: current.service,
        runtime: current.descriptor,
        dataDir,
        execPath: paths.hostPath,
        packaged: paths.packaged,
        smokeTrace: () => undefined,
        handle: (method, handler) => session.handle(method, handler),
      });
      session.send({
        t: "ready",
        v: HOST_PROTOCOL_VERSION,
        runId: hello.runId,
        version: DAEMON_VERSION,
        pid: process.pid,
        startedAtMs: selfStartedAtMs,
        instanceId: current.descriptor.instanceId,
      });
      activeObserver.start();
      activeUpdates.start();
      initialMaintenance = setTimeout(() => void current.service.runMaintenance(), 2500);
      maintenance = setInterval(() => void current.service.runMaintenance(), 60 * 60 * 1000);
      maintenance.unref();
      heartbeat = setInterval(() => lifecycle.record("heartbeat", memoryDetail()), 60_000);
      heartbeat.unref();
      lifecycle.record("ready");
    },
    onEvent(event) {
      // 同步写：宿主回完 WM_ENDSESSION 进程树就会被系统结束，异步链路来不及。
      if (event.name === "session-end") {
        lifecycle.record("session-end");
        session.send({ t: "marked", name: "session-end" });
      }
      if (event.name === "update-launch-failed") updates?.launchFailed();
      if (event.name === "window-shown") {
        lifecycle.record("window.shown", memoryDetail());
        windowMemory.windowShown();
      }
      if (event.name === "window-closed") {
        lifecycle.record("window.closed", memoryDetail());
        windowMemory.windowClosed();
      }
    },
    onClose(reason) {
      if (probed) process.exit(0);
      // 服务还没起来就关闭（超时、协议错误、握手途中断管）：一律按「被拒绝」退出，
      // 不能让校验途中的 onHello 继续往下把服务拉起来。
      if (runtime === null) {
        process.stderr.write(`ATM_CORE_HANDSHAKE_REJECTED ${reason}\n`);
        process.exit(CORE_EXIT_REJECTED);
      }
      // 宿主断管或要求退出：优雅关闭（释放 lease、清发现文件）。
      void shutdown(reason === "protocol-error" ? 1 : 0);
    },
  });
  session.start();
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});

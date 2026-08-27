import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  app,
  autoUpdater,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification as ElectronNotification,
  shell,
  Tray,
} from "electron";
import {
  claudeDesktopConfigPaths,
  defaultClaudeRulePath,
  defaultClaudeSkillsPath,
  defaultCodexRulePath,
  defaultCodexSkillsPath,
  findClaudeCodeCli,
  inspectAgentSkills,
  inspectManagedAgentRule,
  installClaudeCodeConfig,
  installClaudeConfig,
  installCodexConfig,
  installedClaudeCodeProfileLaunches,
  installedClaudeProfileLaunches,
  installedClaudeProfileLaunchSets,
  installedCodexProfileLaunches,
  installAgentSkills,
  isClaudeCodeConfigInstalled,
  isClaudeConfigInstalled,
  isCodexConfigInstalled,
  manageAgentRule,
  renderMcpConfigs,
  uninstallAgentSkills,
  uninstallClaudeCodeConfig,
  uninstallClaudeConfig,
  uninstallCodexConfig,
  type AgentRuleAction,
  type McpClient,
  type McpProfile,
} from "@ayanami-task/agent-config";
import { AyanamiTaskService } from "@ayanami-task/application";
import { AyanamiClient } from "@ayanami-task/client";
import { createCliProgram } from "@ayanami-task/cli";
import { buildAyanamiServer } from "@ayanami-task/daemon";
import { handleSquirrelStartup } from "./squirrel.js";
import {
  classifyUpdateFailure,
  createUpdateDiagnostics,
  updateFeedDir,
  updateFeedReady,
  type UpdatePhase,
  type UpdateStatus,
} from "./updater.js";
import { runStdioMcpProxy } from "@ayanami-task/mcp";
import { installAgentDocumentation } from "./agent-documentation.js";
import {
  installMcpRuntimeLink,
  installMcpStdioBridge,
  mcpLaunch,
  mcpProfileLaunches,
  mcpProfileLaunchesStale,
  mcpStdioHttpPath,
  shouldRepairMcpConfigs,
  type McpLaunch,
  type McpProfileLaunches,
} from "./mcp-launch.js";
import {
  hasManagedMcpProfile,
  memoryProfileEnabledValue,
  profilesRepresentedBy,
  runMcpProfileSwitch,
  type McpProfileSyncAdapter,
} from "./mcp-profile-switch.js";
import { observeMcpBridges } from "./mcp-bridge-observation.js";
import {
  normalizeNotificationMode,
  notificationModes,
  shouldNotify,
  type NotificationMode,
} from "./notification-policy.js";
import { createWindowOptions } from "./window-options.js";
import {
  LOGIN_ITEM_ARGS,
  loginItemExecutable,
  randomStartupDelayMs,
  shouldDelayStartup,
  shouldStartInBackground,
  waitForStartupDelay,
} from "./startup.js";

type Runtime = { endpoint: string; token: string; pid: number; startedAt: string };

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let service: AyanamiTaskService | null = null;
let server: Awaited<ReturnType<typeof buildAyanamiServer>> | null = null;
let runtime: Runtime | null = null;
let maintenanceTimer: NodeJS.Timeout | null = null;
let initialMaintenanceTimer: NodeJS.Timeout | null = null;
let shutdownStarted = false;
let shutdownComplete = false;
let unsubscribeGlobal: (() => void) | null = null;
const unsubscribeProjects = new Map<string, () => void>();
const projectSequences = new Map<string, number>();
const notificationDedup = new Map<string, number>();

function dataDirBeforeReady(): string {
  if (process.env.ATM_DATA_DIR) return process.env.ATM_DATA_DIR;
  return join(process.env.LOCALAPPDATA ?? process.cwd(), "AyanamiTaskManager");
}

const updateDiagnostics = createUpdateDiagnostics(dataDirBeforeReady());

function readRuntime(): Runtime {
  const path = join(dataDirBeforeReady(), "runtime", "daemon.json");
  if (!existsSync(path)) throw new Error("AyanamiTaskManager 服务未运行");
  return JSON.parse(readFileSync(path, "utf8")) as Runtime;
}

function smokeTrace(stage: string, detail: unknown = null): void {
  if (process.env.ATM_PACKAGED_SMOKE !== "1") return;
  const runtimeDir = join(dataDirBeforeReady(), "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  appendFileSync(
    join(runtimeDir, "headless-smoke.ndjson"),
    `${JSON.stringify({ stage, detail, at: new Date().toISOString() })}\n`,
    "utf8",
  );
}

async function runHeadlessModes(args: string[]): Promise<boolean> {
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

function applicationLogoPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "logo.png")
    : join(app.getAppPath(), "logo.png");
}

function bundledDocumentationRoot(): string {
  return app.isPackaged ? process.resourcesPath : app.getAppPath();
}

// 只有这个文件不跟文档同一个相对位置：打包时它被 extraResource 摊平到 resources 根，
// 开发态还在源码树里。
function bundledMcpStdioPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "mcp-stdio.cjs")
    : join(app.getAppPath(), "apps", "desktop", "resources", "mcp-stdio.cjs");
}

/** memory profile 的低内存降级开关；未设置时默认开启完整工具面。 */
const MEMORY_PROFILE_SETTING = "mcp.memory-profile-enabled";
const mcpRepairFailures = new Map<McpClient, string>();

function memoryProfileEnabled(): boolean {
  // 设置缺失或暂时读失败都保持完整能力；只有用户明确写入 false 才降级。
  try {
    return memoryProfileEnabledValue(
      service?.getSetting<boolean>(MEMORY_PROFILE_SETTING, true).value,
    );
  } catch {
    return true;
  }
}

function enabledProfiles(): McpProfile[] {
  return memoryProfileEnabled() ? ["core", "memory"] : ["core"];
}

function profileSyncAdapters(write: {
  command: string;
  args: string[];
  env: Record<string, string>;
}): McpProfileSyncAdapter[] {
  const codex = installedCodexProfileLaunches();
  const claudeCode = installedClaudeCodeProfileLaunches();
  return [
    {
      client: "CODEX",
      target: "Codex",
      present: hasManagedMcpProfile(codex),
      previousProfiles: profilesRepresentedBy(codex),
      apply: (profiles) => void installCodexConfig({ ...write, profiles }),
    },
    ...claudeDesktopConfigPaths().map((path) => {
      const launches = installedClaudeProfileLaunches(path);
      return {
        client: "CLAUDE" as const,
        target: `Claude Desktop (${path})`,
        present: hasManagedMcpProfile(launches),
        previousProfiles: profilesRepresentedBy(launches),
        apply: (profiles: readonly McpProfile[]) =>
          void installClaudeConfig({ ...write, path, profiles }),
      } satisfies McpProfileSyncAdapter;
    }),
    {
      client: "CLAUDE_CODE",
      target: "Claude Code",
      present: hasManagedMcpProfile(claudeCode),
      previousProfiles: profilesRepresentedBy(claudeCode),
      apply: (profiles) => void installClaudeCodeConfig({ ...write, profiles }),
    },
  ];
}

/**
 * 旧配置里的路径钉着 app-<version>，自更新之后就指向一个不存在的文件。光把新配置
 * 写对不够：机器上那份旧的没人会去改——`isInstalled` 一直为真，界面一直显示「已安装」，
 * 用户没有任何理由再点一次安装，只会看到 Agent 连不上而找不到原因。
 *
 * 所以每次启动核对一次，只动 ATM 的受管 server。任何一个客户端出错都不能影响启动：
 * 写入诊断 trace，继续下一个；用户主动切换则走上面的事务化同步，不能吞错。
 */
function repairStaleMcpConfigs(launch: McpLaunch, profiles: McpProfileLaunches): void {
  const write = { command: launch.command, args: launch.args, env: launch.env };
  const enabled = enabledProfiles();
  const clients: Array<{ client: McpClient; stale: () => boolean; repair: () => void }> = [
    {
      client: "CODEX",
      stale: () => mcpProfileLaunchesStale(installedCodexProfileLaunches(), profiles, enabled),
      repair: () => void installCodexConfig({ ...write, profiles: enabled }),
    },
    {
      // Claude 桌面版有两份配置（Store 装的那份被重定向进包容器），任何一份过期都要修：
      // 修了 A 没修 B，就是应用读 B 的那台机器一直坏着，而我们这边看着是绿的。
      client: "CLAUDE",
      stale: () =>
        installedClaudeProfileLaunchSets().some((each) =>
          mcpProfileLaunchesStale(each, profiles, enabled),
        ),
      repair: () => void installClaudeConfig({ ...write, profiles: enabled }),
    },
    {
      // Claude Code 的 user scope 只能由 claude CLI 代写；找不到 CLI 时无从修起，
      // 每次启动抛一次异常也没有意义。
      client: "CLAUDE_CODE",
      stale: () =>
        findClaudeCodeCli() !== null &&
        mcpProfileLaunchesStale(installedClaudeCodeProfileLaunches(), profiles, enabled),
      repair: () => void installClaudeCodeConfig({ ...write, profiles: enabled }),
    },
  ];
  for (const entry of clients) {
    try {
      if (!entry.stale()) continue;
      entry.repair();
      mcpRepairFailures.delete(entry.client);
      smokeTrace("mcp.config-repaired", entry.client);
    } catch (error) {
      mcpRepairFailures.set(entry.client, error instanceof Error ? error.message : String(error));
      smokeTrace("mcp.config-repair-failed", {
        client: entry.client,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// Claude Code 与 Claude Desktop 共用 ~/.claude/CLAUDE.md 与 ~/.claude/skills，
// 只有 MCP 注册位置不同：Desktop 读 claude_desktop_config.json，Claude Code 读 ~/.claude.json。
function agentIntegrationPaths(client: McpClient) {
  return client === "CODEX"
    ? { rulePath: defaultCodexRulePath(), skillsPath: defaultCodexSkillsPath() }
    : { rulePath: defaultClaudeRulePath(), skillsPath: defaultClaudeSkillsPath() };
}

function mcpInstalledFor(client: McpClient): boolean {
  const profiles = enabledProfiles();
  if (client === "CODEX") return isCodexConfigInstalled(undefined, profiles);
  if (client === "CLAUDE") return isClaudeConfigInstalled(undefined, profiles);
  return isClaudeCodeConfigInstalled(undefined, profiles);
}

/**
 * 「还留着任意一个 ATM 的 MCP server」——判据比 mcpInstalledFor 宽，故意的。
 *
 * 卸载共用的规则与技能之前要问的是「另一个客户端是否还在用 ATM」，不是「它是否配得
 * 完全正确」。用严格判据的话，兄弟客户端只要有一项待修（例如刚打开 memory 还没写下去），
 * 就会被判成没装，于是把它还在用的规则和技能一起删掉。
 */
function mcpPresentFor(client: McpClient): boolean {
  if (client === "CODEX") return hasManagedMcpProfile(installedCodexProfileLaunches());
  if (client === "CLAUDE") return installedClaudeProfileLaunchSets().some(hasManagedMcpProfile);
  return hasManagedMcpProfile(installedClaudeCodeProfileLaunches());
}

function agentIntegrationReport(client: McpClient) {
  const paths = agentIntegrationPaths(client);
  return {
    client,
    mcpInstalled: mcpInstalledFor(client),
    repairError: mcpRepairFailures.get(client) ?? null,
    // 规则与技能和哪个客户端同源；UI 合并显示时据此避免重复计数。
    sharesRuleAndSkillsWith: client === "CLAUDE_CODE" ? ("CLAUDE" as const) : null,
    // Claude Code 的 user scope 必须由 claude CLI 代写，找不到时安装按钮应不可用。
    cliAvailable: client === "CLAUDE_CODE" ? findClaudeCodeCli() !== null : true,
    rule: inspectManagedAgentRule(paths.rulePath),
    skills: inspectAgentSkills({
      sourceRoot: join(dataDirBeforeReady(), "skills"),
      targetRoot: paths.skillsPath,
    }),
  };
}

function trayImage() {
  return nativeImage.createFromPath(applicationLogoPath()).resize({ width: 20, height: 20 });
}

function showWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function navigate(route: string): void {
  showWindow();
  mainWindow?.webContents.send("atm:navigate", route);
}

function createWindow(showWhenReady = true): void {
  mainWindow = new BrowserWindow(
    createWindowOptions(
      join(__dirname, "preload.cjs"),
      nativeTheme.shouldUseDarkColors,
      applicationLogoPath(),
    ),
  );
  mainWindow.on("ready-to-show", () => {
    if (showWhenReady) showWindow();
  });
  const publishMaximizedState = () => {
    mainWindow?.webContents.send("atm:window-maximized-changed", mainWindow.isMaximized());
  };
  mainWindow.on("maximize", publishMaximizedState);
  mainWindow.on("unmaximize", publishMaximizedState);
  mainWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  if (process.env.ATM_RENDERER_URL) void mainWindow.loadURL(process.env.ATM_RENDERER_URL);
  else void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
}

function notificationMode(): NotificationMode {
  const mode = service?.databases.getSetting<unknown>("notification.mode", null).value;
  const legacyEnabled = service?.databases.getSetting<unknown>("notification.enabled", true).value;
  return normalizeNotificationMode(mode, legacyEnabled);
}

function autoLaunchEnabled(): boolean {
  return app.getLoginItemSettings({
    path: loginItemExecutable(dataDirBeforeReady()),
    args: [...LOGIN_ITEM_ARGS],
  }).openAtLogin;
}

function setAutoLaunch(enabled: boolean): boolean {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: loginItemExecutable(dataDirBeforeReady()),
    args: [...LOGIN_ITEM_ARGS],
  });
  return autoLaunchEnabled();
}

function trayMenu(): Menu {
  const overview = service?.overview() as any;
  const projects = (overview?.projects ?? []) as any[];
  const blocked = projects.reduce((sum, project) => sum + Number(project.blocked_count ?? 0), 0);
  const waiting = projects.reduce(
    (sum, project) => sum + Number(project.waiting_user_count ?? 0),
    0,
  );
  const mode = notificationMode();
  const notificationLabels: Record<NotificationMode, string> = {
    ALL: "全部通知",
    CRITICAL: "仅严重事件",
    OFF: "不通知",
  };
  return Menu.buildFromTemplate([
    { label: "打开绫波任务管理器", click: showWindow },
    { label: "新建临时任务", click: () => navigate("quick") },
    { label: `受阻 ${blocked} / 等待用户 ${waiting}`, enabled: false },
    // 只在真有待生效的更新时出现——常驻一行「已是最新」是噪音。
    ...(updateDownloaded === null
      ? []
      : [{ label: `${updateDownloaded} 已就绪，重启生效`, enabled: false } as const]),
    { type: "separator" },
    {
      label: `系统通知 · ${notificationLabels[mode]}`,
      submenu: notificationModes.map((candidate) => ({
        label: notificationLabels[candidate],
        type: "radio" as const,
        checked: candidate === mode,
        click: () => {
          service?.setSetting("notification.mode", candidate);
          tray?.setContextMenu(trayMenu());
        },
      })),
    },
    { label: "设置", click: () => navigate("settings") },
    { type: "separator" },
    {
      label: "完全退出",
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
}

function createTray(): void {
  tray = new Tray(trayImage());
  tray.setToolTip("AyanamiTaskManager");
  tray.setContextMenu(trayMenu());
  tray.on("click", showWindow);
  tray.on("double-click", showWindow);
}

function showProjectNotification(
  project: string,
  event: { seq: number; type: string; key: string | null; summary: string | null },
): void {
  const labels: Record<string, string> = {
    "work.waiting": "任务正在等待",
    "work.blocked": "任务受阻",
    "work.completed": "任务已完成",
    "agent.recovered_stale": "Agent 异常退出",
  };
  const title = labels[event.type];
  if (!title || !shouldNotify(notificationMode(), event.type)) return;
  const key = `${project}:${event.type}:${event.key}`;
  const now = Date.now();
  if ((notificationDedup.get(key) ?? 0) > now - 10 * 60_000) return;
  notificationDedup.set(key, now);
  for (const [candidate, at] of notificationDedup)
    if (at < now - 60 * 60_000) notificationDedup.delete(candidate);
  if (ElectronNotification.isSupported()) {
    new ElectronNotification({
      title: `${project} · ${title}`,
      body: event.summary || event.key || title,
      icon: applicationLogoPath(),
    }).show();
  }
}

function ensureProjectSubscriptions(): void {
  if (!service) return;
  const overview = service.overview() as any;
  const active = new Set<string>();
  for (const project of (overview.projects ?? []) as any[]) {
    if (project.lifecycle !== "ACTIVE") continue;
    const code = String(project.code);
    active.add(code);
    if (unsubscribeProjects.has(code)) continue;
    projectSequences.set(code, Number(project.project_sequence ?? 0));
    let running = false;
    let dirty = false;
    const consume = async () => {
      if (!service || running) {
        dirty = true;
        return;
      }
      running = true;
      try {
        do {
          dirty = false;
          let delta;
          do {
            delta = await service.delta(code, projectSequences.get(code) ?? 0, 100);
            for (const event of delta.events) showProjectNotification(code, event);
            const lastEvent = delta.events.at(-1);
            if (lastEvent) projectSequences.set(code, lastEvent.seq);
          } while (delta.hasMore);
        } while (dirty);
      } finally {
        running = false;
        tray?.setContextMenu(trayMenu());
      }
    };
    unsubscribeProjects.set(
      code,
      service.subscribeProject(code, () => void consume()),
    );
  }
  for (const [code, unsubscribe] of unsubscribeProjects) {
    if (!active.has(code)) {
      unsubscribe();
      unsubscribeProjects.delete(code);
      projectSequences.delete(code);
    }
  }
}

function installDesktopEventObservers(): void {
  if (!service) return;
  ensureProjectSubscriptions();
  let sequence = Number((service.overview() as any).sequence ?? 0);
  unsubscribeGlobal = service.subscribeGlobal(() => {
    if (!service) return;
    const delta = service.globalDelta(sequence, 100);
    sequence = delta.nextSequence;
    for (const event of delta.events) {
      if (
        event.type === "backup.failed" &&
        shouldNotify(notificationMode(), event.type) &&
        ElectronNotification.isSupported()
      ) {
        const key = `global:${event.type}:${event.key}`;
        if (!notificationDedup.has(key)) {
          notificationDedup.set(key, Date.now());
          new ElectronNotification({
            title: "备份失败",
            body: event.summary,
            icon: applicationLogoPath(),
          }).show();
        }
      }
    }
    ensureProjectSubscriptions();
    tray?.setContextMenu(trayMenu());
  });
}

async function startApplication(background: boolean): Promise<void> {
  const dataDir = dataDirBeforeReady();
  installAgentDocumentation(bundledDocumentationRoot(), dataDir);
  installMcpStdioBridge(bundledMcpStdioPath(), dataDir);
  installMcpRuntimeLink(process.execPath, dataDir);
  const migrationsRoot = join(app.getAppPath(), "migrations");
  service = await AyanamiTaskService.open({ dataDir, migrationsRoot });
  const runtimeDir = join(dataDir, "runtime");
  const tokenPath = join(runtimeDir, "local.token");
  mkdirSync(runtimeDir, { recursive: true });
  const token = existsSync(tokenPath)
    ? readFileSync(tokenPath, "utf8").trim()
    : randomBytes(32).toString("base64url");
  if (!existsSync(tokenPath))
    writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600, flag: "wx" });
  server = await buildAyanamiServer({ service, token });
  await server.listen({ host: "127.0.0.1", port: 0 });
  const address = server.server.address();
  if (!address || typeof address === "string") throw new Error("DAEMON_TCP_ADDRESS_MISSING");
  runtime = {
    endpoint: `http://127.0.0.1:${address.port}`,
    token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(join(runtimeDir, "daemon.json"), JSON.stringify(runtime), {
    encoding: "utf8",
    mode: 0o600,
  });

  if (process.env.ATM_PACKAGED_SMOKE === "1") {
    const original = autoLaunchEnabled();
    const toggled = setAutoLaunch(!original);
    const restored = setAutoLaunch(original);
    writeFileSync(
      join(runtimeDir, "autolaunch-smoke.json"),
      JSON.stringify({
        original,
        toggled,
        restored,
        path: loginItemExecutable(dataDir),
        args: [...LOGIN_ITEM_ARGS],
        passed: toggled === !original && restored === original,
      }),
      "utf8",
    );
  }

  ipcMain.on("atm:get-runtime", (event) => {
    event.returnValue = runtime;
  });
  ipcMain.handle("atm:get-auto-launch", autoLaunchEnabled);
  ipcMain.handle("atm:set-auto-launch", (_event, enabled: boolean) => setAutoLaunch(enabled));
  ipcMain.handle("atm:get-update-status", () => updateDiagnostics.read());
  ipcMain.handle("atm:check-for-updates", () => checkForUpdates());
  ipcMain.handle("atm:window-minimize", () => {
    mainWindow?.minimize();
  });
  ipcMain.handle("atm:window-toggle-maximize", () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle("atm:window-is-maximized", () => mainWindow?.isMaximized() ?? false);
  ipcMain.handle("atm:window-close", () => {
    mainWindow?.close();
  });
  ipcMain.handle("atm:show-item", (_event, path: string) => shell.showItemInFolder(path));
  const launch = mcpLaunch({ execPath: process.execPath, dataDir: dataDirBeforeReady() });
  const profileLaunches = mcpProfileLaunches({
    execPath: process.execPath,
    dataDir: dataDirBeforeReady(),
  });
  const stdioCommand = launch.command;
  const stdioArgs = launch.args;
  const stdioEnv = launch.env;
  if (shouldRepairMcpConfigs()) repairStaleMcpConfigs(launch, profileLaunches);
  ipcMain.handle("atm:get-mcp-bridges", () => observeMcpBridges({ bridgeCommand: stdioCommand }));
  ipcMain.handle("atm:get-mcp-configs", () => {
    if (!runtime) throw new Error("RUNTIME_NOT_READY");
    return renderMcpConfigs(
      { ...runtime, command: stdioCommand, args: stdioArgs, env: stdioEnv },
      enabledProfiles(),
    );
  });
  ipcMain.handle("atm:get-memory-profile", () => memoryProfileEnabled());
  ipcMain.handle("atm:set-memory-profile", (_event, enabled: boolean) => {
    if (!service) throw new Error("RUNTIME_NOT_READY");
    const current = service.getSetting<boolean>(MEMORY_PROFILE_SETTING, true);
    const write = { command: stdioCommand, args: stdioArgs, env: stdioEnv };
    const result = runMcpProfileSwitch({
      enabled: enabled === true,
      // ATM_DATA_DIR 是烟测/隔离环境，绝不能借设置开关改用户全局 Agent 配置。
      adapters: shouldRepairMcpConfigs() ? profileSyncAdapters(write) : [],
      // 客户端全部同步成功后才提交偏好；失败由 runMcpProfileSwitch 逆序回滚。
      commit: () => {
        service!.setSetting(
          MEMORY_PROFILE_SETTING,
          enabled === true,
          current.version < 0 ? undefined : current.version,
        );
      },
    });
    for (const entry of result.clients) {
      if (entry.status === "UPDATED") mcpRepairFailures.delete(entry.client);
    }
    return result;
  });
  ipcMain.handle("atm:install-mcp", (_event, client: McpClient) => {
    const write = {
      command: stdioCommand,
      args: stdioArgs,
      env: stdioEnv,
      profiles: enabledProfiles(),
    };
    const result =
      client === "CODEX"
        ? installCodexConfig(write)
        : client === "CLAUDE"
          ? installClaudeConfig(write)
          : client === "CLAUDE_CODE"
            ? installClaudeCodeConfig(write)
            : null;
    if (!result) throw new Error("MCP_CLIENT_UNSUPPORTED");
    mcpRepairFailures.delete(client);
    return result;
  });
  ipcMain.handle("atm:get-agent-integrations", () => [
    agentIntegrationReport("CODEX"),
    agentIntegrationReport("CLAUDE"),
    agentIntegrationReport("CLAUDE_CODE"),
  ]);
  ipcMain.handle(
    "atm:manage-agent-integration",
    (_event, client: McpClient, action: AgentRuleAction) => {
      if (!(client === "CODEX" || client === "CLAUDE" || client === "CLAUDE_CODE"))
        throw new Error("MCP_CLIENT_UNSUPPORTED");
      const paths = agentIntegrationPaths(client);
      const skillState = inspectAgentSkills({
        sourceRoot: join(dataDirBeforeReady(), "skills"),
        targetRoot: paths.skillsPath,
      }).state;
      if (
        action !== "PREVIEW" &&
        action !== "UNINSTALL" &&
        skillState === "MODIFIED" &&
        action !== "REPAIR"
      ) {
        throw new Error("AGENT_SKILL_MODIFIED_REQUIRES_REPAIR");
      }
      // CLAUDE 与 CLAUDE_CODE 共用规则与技能路径。卸载其中一个时，只要另一个还装着
      // MCP，就必须保留共用的规则和技能，否则会连带废掉仍在使用的那一个。
      const sibling: McpClient | null =
        client === "CLAUDE" ? "CLAUDE_CODE" : client === "CLAUDE_CODE" ? "CLAUDE" : null;
      const siblingStillInstalled = sibling !== null && mcpPresentFor(sibling);
      const removeSharedAssets = action === "UNINSTALL" && !siblingStillInstalled;
      const rule = manageAgentRule({
        path: paths.rulePath,
        action: action === "UNINSTALL" && !removeSharedAssets ? "PREVIEW" : action,
      });
      if (action === "PREVIEW") return { report: agentIntegrationReport(client), preview: rule };
      if (action === "UNINSTALL") {
        if (client === "CODEX") uninstallCodexConfig();
        else if (client === "CLAUDE") uninstallClaudeConfig();
        else uninstallClaudeCodeConfig();
        if (removeSharedAssets) uninstallAgentSkills(paths.skillsPath);
      } else {
        const profiles = enabledProfiles();
        const write = { command: stdioCommand, args: stdioArgs, env: stdioEnv, profiles };
        if (client === "CODEX" && !isCodexConfigInstalled(undefined, profiles))
          installCodexConfig(write);
        if (client === "CLAUDE" && !isClaudeConfigInstalled(undefined, profiles))
          installClaudeConfig(write);
        if (client === "CLAUDE_CODE" && !isClaudeCodeConfigInstalled(undefined, profiles))
          installClaudeCodeConfig(write);
        if (skillState !== "INSTALLED")
          installAgentSkills({
            sourceRoot: join(dataDirBeforeReady(), "skills"),
            targetRoot: paths.skillsPath,
          });
      }
      mcpRepairFailures.delete(client);
      return { report: agentIntegrationReport(client), preview: null };
    },
  );
  ipcMain.handle("atm:copy-text", (_event, text: string) => {
    clipboard.writeText(text);
    return true;
  });
  initialMaintenanceTimer = setTimeout(() => {
    void service?.runMaintenance();
  }, 2500);
  maintenanceTimer = setInterval(
    () => {
      void service?.runMaintenance();
    },
    60 * 60 * 1000,
  );
  maintenanceTimer.unref();
  createTray();
  createWindow(!background);
  installDesktopEventObservers();
  startAutoUpdate();
}

let updateFeedConfigured = false;
let updateDownloaded: string | null = null;
let updatePhase: UpdatePhase = "CHECK";

function checkForUpdates(): UpdateStatus | null {
  // 开发态没有 Update.exe，autoUpdater 一碰就抛。
  if (!app.isPackaged) return updateDiagnostics.read();
  const dataDir = dataDirBeforeReady();
  // 还没发过任何更新是完全正常的状态，不该在用户面前变成一条报错。
  if (!updateFeedReady(dataDir)) {
    return updateDiagnostics.record({
      phase: "CHECK",
      outcome: "SKIPPED",
      code: "UPDATE_SOURCE_MISSING",
      detail: "当前没有待安装的本地更新",
    });
  }
  updatePhase = "CHECK";
  const checking = updateDiagnostics.record({
    phase: "CHECK",
    outcome: "IN_PROGRESS",
    code: "CHECKING",
    detail: "正在检查本地更新",
  });
  try {
    if (!updateFeedConfigured) {
      autoUpdater.setFeedURL({ url: updateFeedDir(dataDir) });
      updateFeedConfigured = true;
    }
    autoUpdater.checkForUpdates();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const failure = classifyUpdateFailure(detail, updatePhase);
    const status = updateDiagnostics.record({
      ...failure,
      outcome: "ERROR",
      detail,
    });
    smokeTrace("update.check-failed", status);
    return status;
  }
  return checking;
}

function startAutoUpdate(): void {
  if (!app.isPackaged) return;
  autoUpdater.on("checking-for-update", () => {
    updatePhase = "CHECK";
  });
  autoUpdater.on("update-available", () => {
    updatePhase = "DOWNLOAD";
    updateDiagnostics.record({
      phase: "DOWNLOAD",
      outcome: "IN_PROGRESS",
      code: "UPDATE_AVAILABLE",
      detail: "已发现新版本，正在下载并校验",
    });
  });
  autoUpdater.on("update-not-available", () => {
    updatePhase = "READY";
    updateDiagnostics.record({
      phase: "READY",
      outcome: "SUCCESS",
      code: "UP_TO_DATE",
      detail: "当前已是最新版本",
    });
  });
  autoUpdater.on("error", (error: Error) => {
    // 更新失败不能影响正在用的应用：记一笔，继续跑当前版本。
    const failure = classifyUpdateFailure(error, updatePhase);
    const status = updateDiagnostics.record({
      ...failure,
      outcome: "ERROR",
      detail: error,
    });
    smokeTrace("update.error", status);
  });
  autoUpdater.on("update-downloaded", (_event, _notes, releaseName: string) => {
    // Squirrel 已经把新版本铺到 app-<version> 目录；启动壳始终拉最新的那个，
    // 所以不需要 quitAndInstall——下次重启自然就是新版。这里只负责告知，
    // 不打断用户手上的事。
    updateDownloaded = releaseName;
    updatePhase = "READY";
    const status = updateDiagnostics.record({
      phase: "READY",
      outcome: "SUCCESS",
      code: "UPDATE_READY",
      detail: `${releaseName} 已就绪，下次启动生效`,
      version: releaseName,
    });
    smokeTrace("update.downloaded", status);
    tray?.setContextMenu(trayMenu());
    if (notificationMode() === "OFF" || !ElectronNotification.isSupported()) return;
    new ElectronNotification({
      title: "AyanamiTaskManager 已更新",
      body: `${releaseName} 已就绪，下次启动生效。`,
      icon: applicationLogoPath(),
    }).show();
  });
  checkForUpdates();
  const timer = setInterval(checkForUpdates, 6 * 60 * 60 * 1000);
  timer.unref();
}

async function bootstrap(): Promise<void> {
  // Squirrel 生命周期调用必须最先处理：不取单实例锁、不开窗口、不起服务，
  // 做完该做的立刻退出，否则安装过程会挂在这里等到超时。
  if (
    handleSquirrelStartup(process.argv, process.execPath, undefined, (detail) => {
      updateDiagnostics.record({
        phase: "INSTALL",
        outcome: "ERROR",
        code: "INSTALL_FAILED",
        detail,
      });
    })
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
    if (process.env.ATM_PACKAGED_SMOKE === "1" && commandLine.includes("--smoke-quit")) {
      quitting = true;
      startupDelayController.abort();
      app.quit();
      return;
    }
    foregroundRequested = true;
    startupDelayController.abort();
    showWindow();
  });
  await app.whenReady();
  if (shouldDelayStartup(args, process.env.ATM_PACKAGED_SMOKE === "1")) {
    await waitForStartupDelay(randomStartupDelayMs(), startupDelayController.signal);
  }
  await startApplication(shouldStartInBackground(args, foregroundRequested));
  app.on("activate", () => {
    if (!mainWindow) createWindow(true);
    else showWindow();
  });
}

async function shutdown(): Promise<void> {
  if (initialMaintenanceTimer) clearTimeout(initialMaintenanceTimer);
  if (maintenanceTimer) clearInterval(maintenanceTimer);
  initialMaintenanceTimer = null;
  maintenanceTimer = null;
  unsubscribeGlobal?.();
  unsubscribeGlobal = null;
  for (const unsubscribe of unsubscribeProjects.values()) unsubscribe();
  unsubscribeProjects.clear();
  projectSequences.clear();
  if (server) await server.close();
  service?.close();
  server = null;
  service = null;
  if (runtime) rmSync(join(dataDirBeforeReady(), "runtime", "daemon.json"), { force: true });
  runtime = null;
}

app.on("before-quit", (event) => {
  quitting = true;
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
  tray?.destroy();
  tray = null;
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

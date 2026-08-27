import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AyanamiClient } from "../packages/client/src/index.js";
import { MCP_RUNTIME_LINK, mcpLaunch, type McpProfile } from "../apps/desktop/src/mcp-launch.js";

type Runtime = { endpoint: string; token: string; pid: number; startedAt: string };
type RunningApp = { child: ChildProcess; stderr: string[] };
type RecordedMcpLaunch = { command: string; args: string[]; env: Record<string, string> };

const root = process.cwd();
const executable = resolve(
  process.env.ATM_PACKAGED_EXE ??
    join(root, "out", "AyanamiTaskManager-win32-x64", "AyanamiTaskManager.exe"),
);
const outputDir = join(root, "output");
const dataDir = resolve(process.env.ATM_SMOKE_DATA_DIR ?? join(outputDir, "packaged-smoke-data"));
const electronUserDataDir = resolve(
  process.env.ATM_SMOKE_USER_DATA_DIR ?? join(outputDir, "packaged-smoke-electron-profile"),
);
const reportPath = resolve(
  process.env.ATM_SMOKE_REPORT ?? join(outputDir, "packaged-smoke-report.json"),
);
const agentConfigRoot = resolve(join(outputDir, "packaged-smoke-agent-config"));
const smokeHome = join(agentConfigRoot, "Home");
const smokeAppData = join(agentConfigRoot, "Roaming");
const smokeLocalAppData = join(agentConfigRoot, "Local");
const codexConfigPath = join(smokeHome, ".codex", "config.toml");
const claudeConfigPath = join(smokeAppData, "Claude", "claude_desktop_config.json");
const runtimePath = join(dataDir, "runtime", "daemon.json");
const inheritedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);
const smokeEnvironment = {
  ...inheritedEnvironment,
  ATM_DATA_DIR: dataDir,
  ATM_PACKAGED_SMOKE: "1",
  ATM_SMOKE_MCP_CONFIG_REPAIR: "1",
  ATM_SMOKE_AGENT_CONFIG_ROOT: agentConfigRoot,
  HOME: smokeHome,
  USERPROFILE: smokeHome,
  APPDATA: smokeAppData,
  LOCALAPPDATA: smokeLocalAppData,
};
const checks: Array<{ name: string; passed: boolean; detail?: string }> = [];
let recordedAgentProfiles: Record<McpProfile, RecordedMcpLaunch> | null = null;

function check(name: string, condition: unknown, detail?: string): asserts condition {
  checks.push({ name, passed: Boolean(condition), ...(detail === undefined ? {} : { detail }) });
  if (!condition) throw new Error(`${name}：${detail ?? "未通过"}`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitUntil<T>(read: () => Promise<T | null>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value !== null) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw lastError ?? new Error(`等待 ${timeoutMs}ms 超时`);
}

function startApp(): RunningApp {
  const child = spawn(executable, ["--background", `--user-data-dir=${electronUserDataDir}`], {
    cwd: root,
    env: smokeEnvironment,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stderr: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr.push(chunk.toString("utf8"));
    if (stderr.length > 20) stderr.shift();
  });
  return { child, stderr };
}

async function waitForRuntime(app: RunningApp): Promise<Runtime> {
  return waitUntil(async () => {
    if (app.child.exitCode !== null)
      throw new Error(`应用提前退出（${app.child.exitCode}）：${app.stderr.join("")}`);
    if (!existsSync(runtimePath)) return null;
    const runtime = JSON.parse(await readFile(runtimePath, "utf8")) as Runtime;
    const response = await fetch(`${runtime.endpoint}/api/v1/system/status`, {
      headers: { authorization: `Bearer ${runtime.token}` },
    });
    return response.ok ? runtime : null;
  });
}

function recordedLaunch(value: unknown, label: string): RecordedMcpLaunch {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} 不是对象`);
  const object = value as Record<string, unknown>;
  if (typeof object.command !== "string") throw new Error(`${label}.command 缺失`);
  if (!Array.isArray(object.args) || object.args.some((entry) => typeof entry !== "string"))
    throw new Error(`${label}.args 不是字符串数组`);
  const envObject = object.env;
  if (!envObject || typeof envObject !== "object" || Array.isArray(envObject))
    throw new Error(`${label}.env 缺失`);
  const env = Object.fromEntries(
    Object.entries(envObject as Record<string, unknown>).map(([key, entry]) => {
      if (typeof entry !== "string") throw new Error(`${label}.env.${key} 不是字符串`);
      return [key, entry];
    }),
  );
  return { command: object.command, args: object.args as string[], env };
}

async function waitForPackagedAgentProfiles(): Promise<Record<McpProfile, RecordedMcpLaunch>> {
  return waitUntil(async () => {
    if (!existsSync(codexConfigPath) || !existsSync(claudeConfigPath)) return null;
    const codex = await readFile(codexConfigPath, "utf8");
    const claude = JSON.parse(await readFile(claudeConfigPath, "utf8")) as Record<string, any>;
    const servers = claude.mcpServers as Record<string, unknown> | undefined;
    const core = servers?.["ayanami-task-manager-core"];
    const memory = servers?.["ayanami-task-manager-memory"];
    if (!core || !memory) return null;

    check(
      "打包应用迁移 Codex 旧单入口及子表",
      !codex.includes('mcp_servers."ayanami-task-manager"') &&
        !codex.includes("LEGACY_ENV_MUST_DISAPPEAR") &&
        codex.includes('mcp_servers."ayanami-task-manager-core"') &&
        codex.includes('mcp_servers."ayanami-task-manager-memory"'),
      codex,
    );
    check(
      "打包应用迁移 Claude Desktop 且保留无关 server",
      Boolean(servers?.other) && !servers?.["ayanami-task-manager"],
      JSON.stringify(servers),
    );
    return {
      core: recordedLaunch(core, "Claude core"),
      memory: recordedLaunch(memory, "Claude memory"),
    };
  });
}

function installedProfileLaunch(profile: McpProfile): RecordedMcpLaunch {
  if (!recordedAgentProfiles) throw new Error("打包 Agent 配置尚未读回");
  return recordedAgentProfiles[profile];
}

async function waitForExit(child: ChildProcess, timeoutMs = 15_000): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return Promise.race([
    new Promise<number | null>((resolveExit) => child.once("exit", (code) => resolveExit(code))),
    delay(timeoutMs).then(() => null),
  ]);
}

async function stopApp(app: RunningApp): Promise<void> {
  if (app.child.exitCode !== null) return;
  const request = spawn(executable, ["--smoke-quit", `--user-data-dir=${electronUserDataDir}`], {
    cwd: root,
    env: smokeEnvironment,
    windowsHide: true,
    stdio: "ignore",
  });
  await waitForExit(request, 5_000);
  const exitCode = await waitForExit(app.child);
  if (exitCode === null) {
    app.child.kill();
    throw new Error(`应用未能干净退出：${app.stderr.join("")}`);
  }
  await waitUntil(async () => (existsSync(runtimePath) ? null : true), 5_000);
}

async function withProjectEvent<T>(
  runtime: Runtime,
  project: string,
  predicate: (frame: Record<string, unknown>) => boolean,
  action: () => Promise<T>,
): Promise<{ value: T; event: Record<string, unknown> }> {
  const url = new URL(runtime.endpoint);
  url.protocol = "ws:";
  url.pathname = "/api/v1/ws";
  url.searchParams.set("scope", `project:${project}`);
  url.searchParams.set("since", "0");
  const socket = new WebSocket(url);
  let actionStarted = false;
  let actionValue: T | undefined;
  let matchedEvent: Record<string, unknown> | undefined;
  return new Promise((resolveEvent, rejectEvent) => {
    const timeout = setTimeout(() => rejectEvent(new Error("WebSocket 实时事件等待超时")), 15_000);
    const finish = () => {
      if (actionValue === undefined || matchedEvent === undefined) return;
      clearTimeout(timeout);
      socket.close();
      resolveEvent({ value: actionValue, event: matchedEvent });
    };
    socket.addEventListener("open", () =>
      socket.send(JSON.stringify({ type: "authenticate", token: runtime.token })),
    );
    socket.addEventListener("error", () => rejectEvent(new Error("WebSocket 连接失败")));
    socket.addEventListener("message", (message) => {
      const frame = JSON.parse(String(message.data)) as Record<string, unknown>;
      if (frame.type === "authenticated" && !actionStarted) {
        actionStarted = true;
        void action().then((value) => {
          actionValue = value;
          finish();
        }, rejectEvent);
      } else if (predicate(frame)) {
        matchedEvent = frame;
        finish();
      }
    });
  });
}

/**
 * MCP 客户端盯的是它直接拉起的那个进程：那个进程一退，客户端就判定 server 挂了，
 * 哪怕响应已经从继承的管道回来过。
 *
 * 1.0.11 把 command 改成 Squirrel 的启动壳（路径不带版本号，看着更对），而那是给
 * GUI 用的 launcher：拉起真实 exe 之后自己就退出。实测 +5542ms 退出、code 0。
 * 当时验了握手、没验寿命，于是得到「测着是通的、用起来是断的」——用户那边每开一次
 * 会话报一次错。
 *
 * 所以这条单独验寿命：保持 stdin 打开、什么都不发，看它到点还在不在。
 */
async function checkMcpProcessOutlivesHandshake(): Promise<void> {
  const launch = installedProfileLaunch("core");
  const child = spawn(launch.command, launch.args, {
    cwd: root,
    env: { ...smokeEnvironment, ...launch.env },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let exitedAfterMs: number | null = null;
  const started = Date.now();
  child.once("exit", () => (exitedAfterMs = Date.now() - started));
  child.stdin?.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "packaged-smoke", version: "1.0.0" },
      },
    })}\n`,
  );
  // 门槛取 9 秒：启动壳那次是 5.5 秒退的，留足余量又不至于把烟测拖长。
  await delay(9_000);
  const alive = exitedAfterMs === null;
  child.kill();
  check(
    "MCP 进程在握手后仍然存活",
    alive,
    alive ? launch.command : `${launch.command} 在 +${String(exitedAfterMs)}ms 就退出了`,
  );
}

async function createThroughPackagedMcp(
  project: string,
  title: string,
  opId: string,
): Promise<{ session: string; created: Record<string, unknown> }> {
  // 直接用应用写进 Agent 配置的那一份，不再自己拼。原先这里拼的是
  // dirname(executable)/resources/mcp-stdio.cjs——于是烟测证明的是「桥能跑」，
  // 从来没证明过「配置里写的那条路径能跑」。配置钉在 app-1.0.3 上一路留到 1.0.10，
  // 每一轮烟测都是绿的。
  const launch = installedProfileLaunch("core");
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    cwd: root,
    env: { ...smokeEnvironment, ...launch.env },
    stderr: "pipe",
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  const client = new McpClient({ name: "packaged-smoke", version: "1.0.0" });
  try {
    await client.connect(transport);
    const begun = await client.callTool({
      name: "atm_begin",
      arguments: {
        project_code: project,
        mode: "project",
        agent_id: "packaged-smoke",
        client_kind: "release-smoke",
      },
    });
    const session = String((begun.structuredContent as Record<string, unknown>).session);
    const created = await client.callTool({
      name: "atm_task_create",
      arguments: {
        project,
        session,
        op_id: opId,
        items: [{ client_ref: opId, title, status: "READY", acceptance: ["打包环境可读取"] }],
      },
    });
    check(
      `MCP stdio 创建任务 ${title}`,
      (created.structuredContent as Record<string, unknown>).ok === true,
      stderr.join(""),
    );
    return { session, created: created.structuredContent as Record<string, unknown> };
  } catch (error) {
    await delay(100);
    throw new Error(
      `打包 MCP stdio 失败：${error instanceof Error ? error.message : String(error)}${stderr.length ? `\nstderr: ${stderr.join("")}` : ""}`,
      { cause: error },
    );
  } finally {
    await client.close();
  }
}

async function packagedProfileTools(profile: McpProfile): Promise<string[]> {
  const launch = installedProfileLaunch(profile);
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    cwd: root,
    env: { ...smokeEnvironment, ...launch.env },
    stderr: "pipe",
  });
  const client = new McpClient({ name: `packaged-smoke-${profile}`, version: "1.0.0" });
  try {
    await client.connect(transport);
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await client.close();
  }
}

async function packagedDefaultProfileTools(): Promise<string[]> {
  const launch = mcpLaunch({ execPath: executable, dataDir });
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    cwd: root,
    env: { ...smokeEnvironment, ...launch.env },
    stderr: "pipe",
  });
  const client = new McpClient({ name: "packaged-smoke-default-profile", version: "1.0.0" });
  try {
    await client.connect(transport);
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await client.close();
  }
}

async function checkInvalidPackagedProfileFails(): Promise<void> {
  const launch = mcpLaunch({ execPath: executable, dataDir });
  const child = spawn(launch.command, [...launch.args, "--profile", "merged"], {
    cwd: root,
    env: { ...smokeEnvironment, ...launch.env },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.kill();
      rejectExit(new Error("非法 MCP Profile 进程未按时退出"));
    }, 10_000);
    child.once("error", rejectExit);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
  check("非法打包 Profile 非零退出", exitCode !== 0, `exit=${String(exitCode)}`);
  check("非法打包 Profile 给出明确错误", stderr.includes("MCP_PROFILE_INVALID"), stderr);
}

async function claimThroughPackagedMemory(
  project: string,
  session: string,
  taskKey: string,
  expectedVersion: number,
): Promise<void> {
  const launch = installedProfileLaunch("memory");
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    cwd: root,
    env: { ...smokeEnvironment, ...launch.env },
    stderr: "pipe",
  });
  const client = new McpClient({ name: "packaged-smoke-memory", version: "1.0.0" });
  try {
    await client.connect(transport);
    const patched = await client.callTool({
      name: "atm_task_patch",
      arguments: {
        project,
        session,
        op_id: "packaged-smoke-memory-claim",
        items: [{ task_key: taskKey, expected_version: expectedVersion, operation: "claim" }],
      },
    });
    check(
      "memory Profile 修改 core 创建的任务",
      (patched.structuredContent as Record<string, unknown>).ok === true,
    );
  } finally {
    await client.close();
  }
}

if (!existsSync(executable)) throw new Error(`找不到打包应用：${executable}`);
await mkdir(outputDir, { recursive: true });
await mkdir(dirname(reportPath), { recursive: true });
await rm(dataDir, { recursive: true, force: true });
await rm(electronUserDataDir, { recursive: true, force: true });
await rm(agentConfigRoot, { recursive: true, force: true });
await mkdir(dirname(codexConfigPath), { recursive: true });
await mkdir(dirname(claudeConfigPath), { recursive: true });
await writeFile(
  codexConfigPath,
  [
    '[mcp_servers."ayanami-task-manager"]',
    'command = "legacy.exe"',
    '[mcp_servers."ayanami-task-manager".env]',
    'LEGACY_ENV_MUST_DISAPPEAR = "1"',
    "[mcp_servers.other]",
    'command = "keep.exe"',
    "",
  ].join("\n"),
  "utf8",
);
await writeFile(
  claudeConfigPath,
  `${JSON.stringify({
    mcpServers: {
      "ayanami-task-manager": { command: "legacy.exe", args: [] },
      other: { command: "keep.exe", args: [] },
    },
  })}\n`,
  "utf8",
);

let app = startApp();
try {
  const runtime = await waitForRuntime(app);
  recordedAgentProfiles = await waitForPackagedAgentProfiles();
  const client = new AyanamiClient(runtime);
  const status = await client.status();
  check("打包应用健康检查", status.ok === true);
  check(
    "打包 native SQLite 可用",
    Boolean((status.sqlite as Record<string, unknown>)?.sqliteVersion),
  );
  const installedGuide = join(dataDir, "ATM_AGENT_GUIDE.md");
  const installedAgentDocs = join(dataDir, "docs", "agent-integration.md");
  check("Agent Guide 安装到正式数据根", existsSync(installedGuide), installedGuide);
  check("完整 docs 安装到正式数据根", existsSync(installedAgentDocs), installedAgentDocs);
  const guideContent = await readFile(installedGuide, "utf8");
  check(
    "Agent Guide 使用设备无关路径",
    guideContent.includes("%LOCALAPPDATA%\\AyanamiTaskManager\\ATM_AGENT_GUIDE.md") &&
      !guideContent.includes("R:\\Project_All"),
  );

  const project = await client.projects.create({
    name: "打包烟测项目",
    sourcePath: null,
    code: "PSM",
  });
  await client.projects.createObjectiveAsUser(project.code, {
    opId: "packaged-smoke-objective",
    title: "验证打包产物",
    description: "仅使用打包后的应用进行端到端验收",
    definitionOfDone: ["MCP、事件、备份恢复与重启通过"],
  });
  check("创建独立项目数据库", existsSync(project.databasePath), project.databasePath);

  // 桥接脚本必须落在数据根：resources 每版换目录，写进 Agent 配置的路径不能跟着换。
  const bridgePath = join(dataDir, "mcp-stdio.cjs");
  check("MCP 桥接脚本安装到数据根", existsSync(bridgePath), bridgePath);

  // 写进 Agent 配置的 command 也不能带版本号。1.0.12 是靠「启动时把配置改回当前版本」
  // 兜的，可那只改得动盘上的文件，改不动已经把配置读进内存的客户端——Claude 桌面版
  // 一个会话里始终拿启动那一刻的路径去 spawn，于是用户看到 app-1.0.10 ENOENT。
  // 路径本身不认版本，客户端拿多旧的配置都无所谓。
  const launchPath = mcpLaunch({ execPath: executable, dataDir }).command;
  check(
    "MCP 启动路径落在数据根的版本无关链接下",
    launchPath.startsWith(join(dataDir, MCP_RUNTIME_LINK) + sep),
    launchPath,
  );
  check(
    "MCP 启动路径不含 app-<version> 段",
    !/[\\/]app-\d+\.\d+\.\d+[\\/]/u.test(launchPath),
    launchPath,
  );
  for (const [profile, launch] of Object.entries(recordedAgentProfiles)) {
    check(`${profile} 配置使用版本无关启动路径`, launch.command === launchPath, launch.command);
    check(
      `${profile} 配置写入静态 Profile 参数与 Node bridge 环境`,
      launch.args.slice(-2).join(" ") === `--profile ${profile}` &&
        launch.env.ELECTRON_RUN_AS_NODE === "1",
      JSON.stringify(launch),
    );
  }
  await checkMcpProcessOutlivesHandshake();

  const coreTools = await packagedProfileTools("core");
  const memoryTools = await packagedProfileTools("memory");
  const defaultTools = await packagedDefaultProfileTools();
  check(
    "打包 core Profile 工具完整",
    JSON.stringify(coreTools) ===
      JSON.stringify([
        "atm_begin",
        "atm_brief",
        "atm_task_list",
        "atm_task_get",
        "atm_task_create",
        "atm_end",
      ]),
    coreTools.join(", "),
  );
  check(
    "打包 memory Profile 工具完整",
    JSON.stringify(memoryTools) ===
      JSON.stringify([
        "atm_task_patch",
        "atm_progress_add",
        "atm_record",
        "atm_search",
        "atm_delta",
      ]),
    memoryTools.join(", "),
  );
  check(
    "打包双 Profile 工具无重叠且联合为 11 个",
    coreTools.filter((name) => memoryTools.includes(name)).length === 0 &&
      new Set([...coreTools, ...memoryTools]).size === 11,
  );
  check(
    "打包 stdio 未指定 Profile 时固定为 core",
    JSON.stringify(defaultTools) === JSON.stringify(coreTools),
    defaultTools.join(", "),
  );
  await checkInvalidPackagedProfileFails();

  const live = await withProjectEvent(
    runtime,
    project.code,
    (frame) => frame.type === "work.created",
    () => createThroughPackagedMcp(project.code, "打包烟测任务", "packaged-smoke-create-1"),
  );
  check("UI WebSocket 收到 MCP 实时事件", live.event.type === "work.created");
  const liveCreated = (live.value.created.created as Array<Record<string, unknown>>)[0]!;
  await claimThroughPackagedMemory(
    project.code,
    live.value.session,
    String(liveCreated.task_key),
    Number(liveCreated.version),
  );
  const sharedTask = (await client.tasks.list(project.code)).find(
    (task) => task.key === String(liveCreated.task_key),
  );
  check("core / memory Profile 共享同一数据库状态", sharedTask?.status === "CLAIMED");

  const backup = await client.backups.create(project.code);
  await createThroughPackagedMcp(project.code, "恢复后应消失", "packaged-smoke-create-2");
  check("备份后写入第二项", (await client.tasks.list(project.code)).length === 2);
  await client.backups.restore(String(backup.id));
  const restoredTasks = await client.tasks.list(project.code);
  check(
    "在线备份恢复一致",
    restoredTasks.length === 1 && restoredTasks[0]?.title === "打包烟测任务",
  );

  const autoLaunch = JSON.parse(
    await readFile(join(dataDir, "runtime", "autolaunch-smoke.json"), "utf8"),
  ) as { passed: boolean; path: string; args: string[] };
  check("自启动开关写入并恢复", autoLaunch.passed === true);
  check(
    "自启动使用版本无关入口与后台随机延迟参数",
    autoLaunch.path === join(dataDir, "current", "AyanamiTaskManager.exe") &&
      JSON.stringify(autoLaunch.args) ===
        JSON.stringify(["--background", "--random-startup-delay"]),
    `${autoLaunch.path} ${autoLaunch.args.join(" ")}`,
  );

  await stopApp(app);
  check("完全退出清理运行时文件", !existsSync(runtimePath));

  app = startApp();
  const restartedRuntime = await waitForRuntime(app);
  const restartedClient = new AyanamiClient(restartedRuntime);
  const projects = await restartedClient.projects.list();
  const persistedTasks = await restartedClient.tasks.list(project.code);
  check(
    "重启后项目与任务仍在",
    projects.some((entry) => entry.code === project.code) && persistedTasks.length === 1,
  );
  await stopApp(app);

  const report = {
    passed: true,
    executable,
    dataDir,
    completedAt: new Date().toISOString(),
    checks,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  if (app.child.exitCode === null) app.child.kill();
  const report = {
    passed: false,
    executable,
    dataDir,
    completedAt: new Date().toISOString(),
    checks,
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    stderr: app.stderr.join(""),
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  throw error;
}

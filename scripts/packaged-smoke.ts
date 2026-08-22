import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AyanamiClient } from "../packages/client/src/index.js";
import { MCP_RUNTIME_LINK, mcpLaunch } from "../apps/desktop/src/mcp-launch.js";

type Runtime = { endpoint: string; token: string; pid: number; startedAt: string };
type RunningApp = { child: ChildProcess; stderr: string[] };

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
const runtimePath = join(dataDir, "runtime", "daemon.json");
const inheritedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);
const smokeEnvironment = {
  ...inheritedEnvironment,
  ATM_DATA_DIR: dataDir,
  ATM_PACKAGED_SMOKE: "1",
};
const checks: Array<{ name: string; passed: boolean; detail?: string }> = [];

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
  const launch = mcpLaunch({ execPath: executable, dataDir });
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
): Promise<Record<string, unknown>> {
  // 直接用应用写进 Agent 配置的那一份，不再自己拼。原先这里拼的是
  // dirname(executable)/resources/mcp-stdio.cjs——于是烟测证明的是「桥能跑」，
  // 从来没证明过「配置里写的那条路径能跑」。配置钉在 app-1.0.3 上一路留到 1.0.10，
  // 每一轮烟测都是绿的。
  const launch = mcpLaunch({ execPath: executable, dataDir });
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
    return created.structuredContent as Record<string, unknown>;
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

if (!existsSync(executable)) throw new Error(`找不到打包应用：${executable}`);
await mkdir(outputDir, { recursive: true });
await mkdir(dirname(reportPath), { recursive: true });
await rm(dataDir, { recursive: true, force: true });
await rm(electronUserDataDir, { recursive: true, force: true });

let app = startApp();
try {
  const runtime = await waitForRuntime(app);
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
  await checkMcpProcessOutlivesHandshake();

  const live = await withProjectEvent(
    runtime,
    project.code,
    (frame) => frame.type === "work.created",
    () => createThroughPackagedMcp(project.code, "打包烟测任务", "packaged-smoke-create-1"),
  );
  check("UI WebSocket 收到 MCP 实时事件", live.event.type === "work.created");

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
  ) as { passed: boolean };
  check("自启动开关写入并恢复", autoLaunch.passed === true);

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

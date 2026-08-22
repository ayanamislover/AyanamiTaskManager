import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const MCP_STDIO_FILENAME = "mcp-stdio.cjs";

export type McpLaunch = { command: string; args: string[]; env: Record<string, string> };

/**
 * MCP 配置里的 `command` 必须是一个**会一直活着**的进程，`args` 必须与版本号无关。
 * 这两条约束互相拉扯，最后的取舍是：command 认版本、靠启动时修复跟上；args 不认版本。
 *
 * 起因：原先两处都带 `app-<version>`（execPath 与 resourcesPath），而 Squirrel 每次更新
 * 都换一个 `app-<version>` 目录，旧目录迟早被删。表现只有「Agent 连不上 ATM」一条，
 * 应用本身完全正常。实测配置停在 1.0.3、应用已经跑到 1.0.10。
 *
 * **不能用 Squirrel 在安装根留下的那个启动壳**，尽管它的路径不带版本号。它是给 GUI
 * 准备的 launcher：拉起真实 exe 之后自己就退出。实测同一份配置下——
 *
 *   启动壳：+5542ms 自行退出 code=0（stdin 仍打开）
 *   真实 exe：12 秒全程存活
 *
 * ——握手能成功（输出经继承的管道回来了），可 MCP 客户端盯的是直接子进程：它一退，
 * 客户端就判定 server 挂了。只验握手不验进程寿命，会得到「测着是通的、用起来是断的」。
 *
 * 所以 command 用真实 exe，认版本号；让它安全的是启动时的修复（见 mcpLaunchStale）。
 * 这条链路是自洽的：桥接脚本要读 `runtime/daemon.json` 才能干活，也就是说 ATM 必须
 * 正在运行；而 ATM 一旦启动就已经把配置修到自己这一版了。Squirrel 也不会删掉正在
 * 运行的那一版。因此「配置指向的 exe 不存在」这个状态不会出现。
 *
 * args 仍然不认版本：桥接脚本复制一份到数据根，每次启动覆盖。少一处要跟着版本走的
 * 东西，就少一处会走丢。
 */
export function mcpLaunch(input: { execPath: string; dataDir: string }): McpLaunch {
  return {
    command: input.execPath,
    args: [join(input.dataDir, MCP_STDIO_FILENAME)],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

/**
 * 桥接脚本复制到数据根。resources 每版换目录，数据根不换；每次启动覆盖，
 * 所以它始终是当前版本的那一份。
 */
export function installMcpStdioBridge(source: string, dataDir: string): string {
  if (!existsSync(source)) throw new Error(`MCP_STDIO_BRIDGE_MISSING: ${source}`);
  mkdirSync(dataDir, { recursive: true });
  const target = join(dataDir, MCP_STDIO_FILENAME);
  copyFileSync(source, target);
  return target;
}

/**
 * 自动修复只在应用跑在自己的正常数据根上时做。
 *
 * 烟测、e2e 与并排安装都会用 ATM_DATA_DIR 指到临时目录。那时算出来的启动方式指向
 * 那个临时目录，而修复写的是**全局**的 Agent 配置——等临时目录被删掉，用户的配置
 * 就指向一个不存在的路径，正好制造出这次要修的那个故障，而且是我们自己制造的。
 *
 * 用户手动点安装不受影响：那是明示的意图，写什么都是他自己选的。
 */
export function shouldRepairMcpConfigs(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.ATM_DATA_DIR;
}

/**
 * 已登记的启动方式与当前应当写入的不一致，就要改回来。
 *
 * 没装的不算过期——那是用户没装，不是坏了，不能借着「修复」替他装上。
 */
export function mcpLaunchStale(
  installed: { command: string; args: string[] } | null,
  expected: McpLaunch,
): boolean {
  if (!installed) return false;
  return (
    installed.command !== expected.command ||
    installed.args.length !== expected.args.length ||
    installed.args.some((value, index) => value !== expected.args[index])
  );
}

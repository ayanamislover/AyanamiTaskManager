import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const MCP_STDIO_FILENAME = "mcp-stdio.cjs";

export type McpLaunch = { command: string; args: string[]; env: Record<string, string> };

/**
 * 写进 Agent 的 MCP 配置里的每一个路径都必须与版本号无关。
 *
 * 原先两处都带 `app-<version>`：可执行文件取自 `process.execPath`，桥接脚本取自
 * `process.resourcesPath`。Squirrel 每次更新都把新版本铺到一个新的 `app-<version>`
 * 目录，旧目录迟早被删——于是配置指向一个不存在的文件。它的表现是「Agent 连不上
 * ATM」，而应用本身完全正常，日志里也没有任何异常，没人会想到去看配置里那串版本号。
 * 实测配置停在 1.0.3、应用已经跑到 1.0.10 才被发现，中间每一次自更新都在扩大裂口。
 *
 * 这个缺陷是自更新带来的：以前每次发版都卸载重装、顺手重新安装配置，版本号是对的。
 * 一旦应用能自己换版本而配置不跟着换，版本号就成了两边之间的硬耦合。
 *
 * 两处都换成不随版本变的位置：
 * - 可执行文件用 Squirrel 在安装根留下的启动壳。它永远拉最新的 `app-<version>`，
 *   并且原样转发参数与 `ELECTRON_RUN_AS_NODE`（已实测：与真实 exe 输出逐字相同）。
 * - 桥接脚本复制一份到数据根，那里跨版本稳定；每次启动覆盖，随应用一起更新。
 *
 * portable 包不是 Squirrel 安装，没有启动壳，这时只能用 execPath——但 portable
 * 解压到哪跑到哪，本来就没有「更新换目录」这回事。
 */
export function mcpLaunch(input: {
  execPath: string;
  dataDir: string;
  exists?: (path: string) => boolean;
}): McpLaunch {
  const exists = input.exists ?? existsSync;
  const installRoot = resolve(dirname(input.execPath), "..");
  const stub = join(installRoot, "AyanamiTaskManager.exe");
  // 只有 Squirrel 安装才有 Update.exe。两个都在才认这是启动壳，否则宁可用 execPath：
  // 猜错方向会写出一个根本不存在的 command，比版本钉死还糟。
  const squirrelInstall = exists(join(installRoot, "Update.exe")) && exists(stub);
  return {
    command: squirrelInstall ? stub : input.execPath,
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

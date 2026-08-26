import { basename, dirname, join } from "node:path";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";

export const MCP_STDIO_FILENAME = "mcp-stdio.cjs";

/** 数据根下这个目录链接始终指向当前版本的安装目录，名字永远不变。 */
export const MCP_RUNTIME_LINK = "current";

export type McpLaunch = { command: string; args: string[]; env: Record<string, string> };

/**
 * MCP 配置里的 `command` 必须是一个**会一直活着**的进程，且路径必须与版本号无关。
 *
 * 起因：原先 command 与 args 都带 `app-<version>`（execPath 与 resourcesPath），而 Squirrel
 * 每次更新都换一个 `app-<version>` 目录，旧目录迟早被删。表现只有「Agent 连不上 ATM」
 * 一条，应用本身完全正常。实测配置停在 1.0.3、应用已经跑到 1.0.10。
 *
 * 两条走不通的路，都验过：
 *
 * 1. **Squirrel 在安装根留下的启动壳**（1.0.11 用的）。路径确实不带版本号，但它是给 GUI
 *    准备的 launcher：拉起真实 exe 之后自己就退出。同一份配置下实测——启动壳 +5542ms
 *    自行退出 code=0（stdin 仍打开），真实 exe 12 秒全程存活。握手能成功（输出经继承的
 *    管道回来了），可 MCP 客户端盯的是直接子进程：它一退，客户端就判定 server 挂了。
 * 2. **command 认版本、靠启动时修复跟上**（1.0.12 用的）。修复本身是对的，但它只能修
 *    盘上那份文件，修不了**已经把配置读进内存的客户端**——Claude 桌面版在启动时读一次，
 *    之后 ATM 再怎么改盘上的配置，那个会话都还在拿旧路径 spawn。用户看到的就是
 *    `spawn ...app-1.0.10\AyanamiTaskManager.exe ENOENT`。
 *
 * 所以路径本身必须不认版本：数据根下建一个目录链接（NTFS junction，**不需要管理员
 * 权限**），每次启动重新指向当前安装目录，command 走链接。客户端拿着多久以前的配置
 * 都无所谓，那个路径永远存在、永远是当前版本。实测穿透后 Electron 正常以 Node 运行，
 * `process.execPath` 就是链接路径。
 *
 * 建不出链接时回落到真实 exe——那就退回 1.0.12 的行为（靠启动时修复），是下限不是缺陷。
 */
export function mcpLaunch(input: { execPath: string; dataDir: string }): McpLaunch {
  const linked = join(input.dataDir, MCP_RUNTIME_LINK, basename(input.execPath));
  return {
    command: existsSync(linked) ? linked : input.execPath,
    args: [join(input.dataDir, MCP_STDIO_FILENAME)],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

/**
 * 把数据根下那个版本无关的目录链接指向当前安装目录。
 *
 * 已经指得对就不动：重建有一个「链接不存在」的窗口，正好落在那一刻的 spawn 会失败。
 *
 * 删除只用 `rmdirSync` / `unlinkSync`。两个都只作用在链接本身，不可能穿透进目标——
 * 万一哪天这里换成递归删除，删掉的就是用户装好的应用。这不是洁癖：链接指向安装根。
 */
export function installMcpRuntimeLink(execPath: string, dataDir: string): string | null {
  const target = dirname(execPath);
  const link = join(dataDir, MCP_RUNTIME_LINK);
  try {
    mkdirSync(dataDir, { recursive: true });
    // existsSync 会沿着 junction 看目标：旧 app-<version> 已删时它返回 false，
    // 但链接目录项本身仍在。随后直接 symlink 会 EEXIST，并被 catch 静默回退到
    // 带版本号的真实 exe。lstat 看的是目录项本身，悬空链接也能被识别和换指。
    const stat = lstatSync(link, { throwIfNoEntry: false });
    if (stat) {
      if (!stat.isSymbolicLink()) return null; // 有人拿真目录占了位，不替他做主删掉
      if (readlinkSync(link) === target) return link;
      // rmdir 删 Windows 的 junction，unlink 删 POSIX 的目录符号链接。两个都只作用在
      // 链接本身；这里绝不能出现任何 recursive 删除。
      try {
        rmdirSync(link);
      } catch {
        unlinkSync(link);
      }
    }
    symlinkSync(target, link, "junction");
    return existsSync(join(link, basename(execPath))) ? link : null;
  } catch {
    return null;
  }
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

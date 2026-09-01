import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readlinkSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";

export const MCP_STDIO_FILENAME = "mcp-stdio.cjs";

/** 数据根下这个目录链接始终指向当前版本的安装目录，名字永远不变。 */
export const MCP_RUNTIME_LINK = "current";

export type McpLaunch = { command: string; args: string[]; env: Record<string, string> };
export type McpProfile = "core" | "memory" | "actions";
export type McpProfileLaunches = Record<McpProfile, McpLaunch>;

/**
 * 新配置必须显式选择静态 Profile；无参数只属于升级前仍驻留在客户端内存里的旧配置，
 * 因而走 `/mcp` 的完整兼容窗口，不能静默降成 core。
 */
export function mcpStdioHttpPath(args: readonly string[]): string {
  const profileIndex = args.indexOf("--profile");
  if (profileIndex < 0) return "/mcp";
  const profile = args[profileIndex + 1];
  if (profile !== "core" && profile !== "memory" && profile !== "actions")
    throw new Error("MCP_PROFILE_INVALID: expected core, memory or actions");
  return `/mcp/${profile}`;
}

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
 * 两个 MCP server 共用同一个长寿命 bridge 与数据根，只用显式参数选择静态工具面。
 * Profile 不能交给客户端动态请求，否则 tools/list 又会在运行期膨胀回单一大列表。
 */
export function mcpProfileLaunches(input: {
  execPath: string;
  dataDir: string;
}): McpProfileLaunches {
  const base = mcpLaunch(input);
  return {
    core: { ...base, args: [...base.args, "--profile", "core"] },
    memory: { ...base, args: [...base.args, "--profile", "memory"] },
    actions: { ...base, args: [...base.args, "--profile", "actions"] },
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
  const link = join(dataDir, MCP_RUNTIME_LINK);
  // Electron 保留进程的启动路径：若登录项从 `current\\AyanamiTaskManager.exe` 启动，
  // process.execPath 仍然落在 current 下面。直接 dirname(execPath) 会把 current 重建成
  // 指向自身的 junction，下一次 MCP spawn 就只剩 Transport closed。先穿透链接取得真实
  // app-<version> 目录；解析失败时也必须靠下面的自引用守卫 fail closed。
  let target: string;
  try {
    target = dirname(realpathSync.native(execPath));
  } catch {
    target = dirname(resolve(execPath));
  }
  const samePath = (left: string, right: string): boolean => {
    const resolvedLeft = resolve(left);
    const resolvedRight = resolve(right);
    return process.platform === "win32"
      ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
      : resolvedLeft === resolvedRight;
  };
  if (samePath(target, link)) return null;
  try {
    mkdirSync(dataDir, { recursive: true });
    // existsSync 会沿着 junction 看目标：旧 app-<version> 已删时它返回 false，
    // 但链接目录项本身仍在。随后直接 symlink 会 EEXIST，并被 catch 静默回退到
    // 带版本号的真实 exe。lstat 看的是目录项本身，悬空链接也能被识别和换指。
    const stat = lstatSync(link, { throwIfNoEntry: false });
    if (stat) {
      if (!stat.isSymbolicLink()) return null; // 有人拿真目录占了位，不替他做主删掉
      if (samePath(readlinkSync(link), target)) return link;
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
  if (!env.ATM_DATA_DIR) return true;
  if (env.ATM_PACKAGED_SMOKE !== "1" || env.ATM_SMOKE_MCP_CONFIG_REPAIR !== "1") return false;
  const root = env.ATM_SMOKE_AGENT_CONFIG_ROOT;
  if (!root) return false;
  const inside = (candidate: string | undefined) => {
    if (!candidate) return false;
    const path = relative(resolve(root), resolve(candidate));
    return path === "" || (!path.startsWith("..") && !isAbsolute(path));
  };
  return [env.APPDATA, env.LOCALAPPDATA, env.USERPROFILE].every(inside);
}

/**
 * 已登记的启动方式与当前应当写入的不一致，就要改回来。
 *
 * 没装的不算过期——那是用户没装，不是坏了，不能借着「修复」替他装上。
 */
export function mcpLaunchStale(
  installed: { command: string; args: string[]; env?: Record<string, string> } | null,
  expected: McpLaunch,
): boolean {
  if (!installed) return false;
  const sortedEntries = (value: Record<string, string>) =>
    JSON.stringify(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
  return (
    installed.command !== expected.command ||
    installed.args.length !== expected.args.length ||
    installed.args.some((value, index) => value !== expected.args[index]) ||
    sortedEntries(installed.env ?? {}) !== sortedEntries(expected.env)
  );
}

/**
 * 过期 = 已登记的受管 server 集合与**当前启用集合**对不上，或对得上但启动方式变了。
 *
 * `profiles` 必须传进来，因为这个函数每次启动都跑一遍：它要是不认识「memory 已被关掉」，
 * 就会年复一年地把用户刚关掉的 memory 判成「缺失」再补回去，表现是开关按下去没反应。
 * 默认取 core + memory + actions，与产品默认的完整工具面一致；低内存降级必须显式传 ["core"]。
 */
export function mcpProfileLaunchesStale(
  installed: {
    legacy: (Pick<McpLaunch, "command" | "args"> & { env?: Record<string, string> }) | null;
    core: (Pick<McpLaunch, "command" | "args"> & { env?: Record<string, string> }) | null;
    memory: (Pick<McpLaunch, "command" | "args"> & { env?: Record<string, string> }) | null;
    actions?: (Pick<McpLaunch, "command" | "args"> & { env?: Record<string, string> }) | null;
  },
  expected: McpProfileLaunches,
  profiles: readonly McpProfile[] = ["core", "memory", "actions"],
): boolean {
  const hasAny =
    installed.legacy !== null ||
    installed.core !== null ||
    installed.memory !== null ||
    (installed.actions ?? null) !== null;
  // 一个都没装就是用户没装，不能借着「修复」替他装上。
  if (!hasAny) return false;
  if (installed.legacy !== null) return true;
  const enabled = new Set<McpProfile>(profiles);
  enabled.add("core");
  for (const profile of ["core", "memory", "actions"] as const) {
    const entry = installed[profile] ?? null;
    // 关掉了却还登记着 → 要移除；开着却缺 → 要补上。两边都算过期。
    if (!enabled.has(profile)) {
      if (entry !== null) return true;
      continue;
    }
    if (entry === null) return true;
    if (mcpLaunchStale(entry, expected[profile])) return true;
  }
  return false;
}

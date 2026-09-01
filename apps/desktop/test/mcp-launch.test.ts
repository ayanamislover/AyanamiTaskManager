import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installClaudeConfig,
  installCodexConfig,
  installedClaudeProfileLaunches,
  installedCodexProfileLaunches,
} from "@ayanami-task/agent-config";
import {
  installMcpRuntimeLink,
  installMcpStdioBridge,
  mcpLaunch,
  mcpProfileLaunchesStale,
  mcpProfileLaunches,
  mcpLaunchStale,
  mcpStdioHttpPath,
  MCP_RUNTIME_LINK,
  MCP_STDIO_FILENAME,
  shouldManageMcpRuntime,
  shouldRepairMcpConfigs,
} from "../src/mcp-launch.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "atm-launch-"));
  temporary.push(root);
  return root;
}

// 夹具版本号不能取任何真实版本：升版时的残留扫描按「引号里出现旧版本号」判定
// 漏改站点，用真实版本会把这个文件误报成版本站点，而它根本不是。
const FIXTURE_VERSION = "9.9.9";

/** Squirrel 安装：安装根有启动壳与 Update.exe，真实 exe 在 app-<version> 里。 */
function squirrelInstall(version: string): { installRoot: string; execPath: string } {
  const installRoot = scratch();
  writeFileSync(join(installRoot, "AyanamiTaskManager.exe"), "stub", "utf8");
  writeFileSync(join(installRoot, "Update.exe"), "updater", "utf8");
  mkdirSync(join(installRoot, `app-${version}`), { recursive: true });
  const execPath = join(installRoot, `app-${version}`, "AyanamiTaskManager.exe");
  writeFileSync(execPath, "real", "utf8");
  return { installRoot, execPath };
}

describe("MCP 启动方式", () => {
  it("无 Profile 的旧 Electron 入口走完整 legacy 路由，显式 Profile 保持拆分", () => {
    expect(mcpStdioHttpPath(["--mcp-stdio"])).toBe("/mcp");
    expect(mcpStdioHttpPath(["--mcp-stdio", "--profile", "core"])).toBe("/mcp/core");
    expect(mcpStdioHttpPath(["--mcp-stdio", "--profile", "memory"])).toBe("/mcp/memory");
    expect(() => mcpStdioHttpPath(["--mcp-stdio", "--profile", "merged"])).toThrow(
      /MCP_PROFILE_INVALID/u,
    );
  });

  // 装了链接之后，command 与 args 都不认版本。这是这套东西唯一的目的：
  // 客户端在会话开始时把配置读进内存，之后 ATM 再怎么改盘上那份都影响不到它，
  // 所以路径本身必须永远有效，而不是靠别人重新读一遍配置。
  it("command 走数据根下版本无关的链接，不带 app-<version>", () => {
    const { installRoot, execPath } = squirrelInstall(FIXTURE_VERSION);
    const dataDir = scratch();
    installMcpRuntimeLink(execPath, dataDir);
    const launch = mcpLaunch({ execPath, dataDir });

    expect(launch.command).toBe(join(dataDir, MCP_RUNTIME_LINK, "AyanamiTaskManager.exe"));
    expect(launch.command).not.toContain(`app-${FIXTURE_VERSION}`);
    // 也不是安装根那个启动壳：它是给 GUI 用的 launcher，拉起真实 exe 之后自己就退出
    //（实测 +5542ms，code 0，stdin 还开着；真实 exe 同样条件下 12 秒全程存活）。
    // 握手会成功——输出经继承的管道回来了——但客户端盯的是直接子进程。
    expect(launch.command).not.toBe(join(installRoot, "AyanamiTaskManager.exe"));
    expect(launch.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
    // 穿透之后拿到的确实是 app-<version> 里那个真实 exe。
    expect(readFileSync(launch.command, "utf8")).toBe("real");
  });

  // 1.0.12 是靠「每次启动把配置改回当前版本」兜的，兜不住已经把配置读进内存的客户端。
  // 现在换版本对配置是零改动，也就没有需要客户端配合的时机。
  it("换了版本目录，启动方式一字不变，也不判为过期", () => {
    const dataDir = scratch();
    const first = squirrelInstall("1.0.1").execPath;
    const second = squirrelInstall("1.0.2").execPath;

    installMcpRuntimeLink(first, dataDir);
    const before = mcpLaunch({ execPath: first, dataDir });
    installMcpRuntimeLink(second, dataDir);
    const after = mcpLaunch({ execPath: second, dataDir });

    expect(after).toEqual(before);
    expect(mcpLaunchStale(before, after)).toBe(false);
    // 而链接确实换指了：拿到的是新版本那个 exe。
    expect(readlinkSync(join(dataDir, MCP_RUNTIME_LINK))).toBe(dirname(second));
  });

  it("旧版本目录已删除导致 junction 悬空时仍能换指到新版本", () => {
    const dataDir = scratch();
    const first = squirrelInstall("1.0.1").execPath;
    const second = squirrelInstall("1.0.2").execPath;
    const link = installMcpRuntimeLink(first, dataDir)!;
    rmSync(dirname(first), { recursive: true, force: true });
    expect(existsSync(link)).toBe(false);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);

    expect(installMcpRuntimeLink(second, dataDir)).toBe(link);
    expect(readlinkSync(link)).toBe(dirname(second));
    expect(readFileSync(join(link, "AyanamiTaskManager.exe"), "utf8")).toBe("real");
  });

  it("已经指对时不重建——重建的空窗期里 spawn 会失败", () => {
    const { execPath } = squirrelInstall(FIXTURE_VERSION);
    const dataDir = scratch();
    const link = installMcpRuntimeLink(execPath, dataDir)!;
    const created = lstatSync(link).ctimeMs;

    expect(installMcpRuntimeLink(execPath, dataDir)).toBe(link);
    expect(lstatSync(link).ctimeMs).toBe(created);
  });

  it("应用经 current 启动时仍保留指向真实版本目录的链接", () => {
    const { execPath } = squirrelInstall(FIXTURE_VERSION);
    const dataDir = scratch();
    const link = installMcpRuntimeLink(execPath, dataDir)!;
    const linkedExecPath = join(link, "AyanamiTaskManager.exe");

    expect(installMcpRuntimeLink(linkedExecPath, dataDir)).toBe(link);
    expect(readlinkSync(link)).toBe(dirname(execPath));
    expect(readFileSync(linkedExecPath, "utf8")).toBe("real");
  });

  it("发现遗留的自引用 current junction 时能恢复到真实版本目录", () => {
    const { execPath } = squirrelInstall(FIXTURE_VERSION);
    const dataDir = scratch();
    const link = join(dataDir, MCP_RUNTIME_LINK);
    symlinkSync(link, link, "junction");

    expect(readlinkSync(link)).toBe(link);
    expect(installMcpRuntimeLink(execPath, dataDir)).toBe(link);
    expect(readlinkSync(link)).toBe(dirname(execPath));
    expect(readFileSync(join(link, "AyanamiTaskManager.exe"), "utf8")).toBe("real");
  });

  // 这条链接指向的是**安装根**。数据根被递归删除的场合到处都是（烟测的临时数据根、
  // 用户清数据），只要哪个删除动作穿透了链接，删掉的就是用户装好的应用。
  it("递归删掉数据根不会穿透链接删掉安装目录", () => {
    const { installRoot, execPath } = squirrelInstall(FIXTURE_VERSION);
    const dataDir = scratch();
    installMcpRuntimeLink(execPath, dataDir);

    rmSync(dataDir, { recursive: true, force: true });

    expect({ dataDir: existsSync(dataDir), exe: existsSync(execPath) }).toEqual({
      dataDir: false,
      exe: true,
    });
    expect(existsSync(installRoot)).toBe(true);
  });

  // 位置被真目录占了就退开：那不是我们建的，删它等于替用户做主删他的东西。
  // 回落到真实 exe——那是 1.0.12 的行为，是下限不是缺陷。
  it("位置被真目录占住时回落到真实 exe，不动那个目录", () => {
    const { execPath } = squirrelInstall(FIXTURE_VERSION);
    const dataDir = scratch();
    const squatter = join(dataDir, MCP_RUNTIME_LINK);
    mkdirSync(squatter, { recursive: true });
    writeFileSync(join(squatter, "someone-elses.txt"), "keep", "utf8");

    expect(installMcpRuntimeLink(execPath, dataDir)).toBeNull();
    expect(readFileSync(join(squatter, "someone-elses.txt"), "utf8")).toBe("keep");
    expect(mcpLaunch({ execPath, dataDir }).command).toBe(execPath);
  });

  it("桥接脚本的路径落在数据根，且不含版本号", () => {
    const { execPath } = squirrelInstall(FIXTURE_VERSION);
    const dataDir = scratch();
    const launch = mcpLaunch({ execPath, dataDir });

    expect(launch.args).toEqual([join(dataDir, MCP_STDIO_FILENAME)]);
    expect({
      arg: launch.args[0],
      pinned: launch.args[0]!.includes(`app-${FIXTURE_VERSION}`),
    }).toEqual({ arg: launch.args[0], pinned: false });
  });

  it("为同一份 bridge 生成固定 core / memory / actions 启动参数", () => {
    const { execPath } = squirrelInstall(FIXTURE_VERSION);
    const dataDir = scratch();
    const launches = mcpProfileLaunches({ execPath, dataDir });
    const bridge = join(dataDir, MCP_STDIO_FILENAME);

    expect(launches.core).toEqual({
      command: execPath,
      args: [bridge, "--profile", "core"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(launches.memory).toEqual({
      command: execPath,
      args: [bridge, "--profile", "memory"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(launches.actions).toEqual({
      command: execPath,
      args: [bridge, "--profile", "actions"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
  });

  it("桥接脚本复制到数据根，源缺失时大声报错", () => {
    const source = join(scratch(), MCP_STDIO_FILENAME);
    writeFileSync(source, "// bridge\n", "utf8");
    const dataDir = join(scratch(), "nested");
    const target = installMcpStdioBridge(source, dataDir);
    expect(target).toBe(join(dataDir, MCP_STDIO_FILENAME));
    expect(readFileSync(target, "utf8")).toBe("// bridge\n");

    expect(() => installMcpStdioBridge(join(scratch(), "gone.cjs"), dataDir)).toThrow(
      /MCP_STDIO_BRIDGE_MISSING/u,
    );
  });
});

const EXPECTED = {
  command: "C:\\Users\\x\\AppData\\Local\\AyanamiTaskManagerDesktop\\AyanamiTaskManager.exe",
  args: ["C:\\Users\\x\\AppData\\Local\\AyanamiTaskManager\\mcp-stdio.cjs"],
  env: { ELECTRON_RUN_AS_NODE: "1" },
};

// 机器上留下的那份长这样：两个路径都钉在同一个 app-<version> 里。
const PINNED = {
  command: "C:\\old\\app-1.0.3\\AyanamiTaskManager.exe",
  args: ["C:\\old\\app-1.0.3\\resources\\mcp-stdio.cjs"],
};

describe("过期判定", () => {
  // 默认双入口；启用集合如何影响判定，由 mcp-profile-stale.test.ts 单独守着。
  it("双 Profile 全部逐字一致才不修，旧单入口或任一缺失都迁移", () => {
    const both = ["core", "memory"] as const;
    const expected = {
      core: { ...EXPECTED, args: [...EXPECTED.args, "--profile", "core"] },
      memory: { ...EXPECTED, args: [...EXPECTED.args, "--profile", "memory"] },
    };
    expect(
      mcpProfileLaunchesStale(
        { legacy: null, core: expected.core, memory: expected.memory },
        expected,
        both,
      ),
    ).toBe(false);
    expect(
      mcpProfileLaunchesStale({ legacy: EXPECTED, core: null, memory: null }, expected, both),
    ).toBe(true);
    expect(
      mcpProfileLaunchesStale({ legacy: null, core: expected.core, memory: null }, expected, both),
    ).toBe(true);
    expect(
      mcpProfileLaunchesStale(
        { legacy: null, core: PINNED, memory: expected.memory },
        expected,
        both,
      ),
    ).toBe(true);
  });

  it("命令或参数对不上就算过期，一致就不动", () => {
    expect(
      mcpLaunchStale(
        { command: EXPECTED.command, args: [...EXPECTED.args], env: { ...EXPECTED.env } },
        EXPECTED,
      ),
    ).toBe(false);
    expect(mcpLaunchStale(PINNED, EXPECTED)).toBe(true);
    // 只有参数变了也要修——桥接脚本换位置时就是这种。
    expect(
      mcpLaunchStale({ command: EXPECTED.command, args: ["C:\\old\\mcp-stdio.cjs"] }, EXPECTED),
    ).toBe(true);
    expect(mcpLaunchStale({ command: EXPECTED.command, args: [] }, EXPECTED)).toBe(true);
  });

  // 没装不是「坏了」。借着修复替用户装上，等于未经允许改别人的 Agent 配置。
  it("没装的不算过期", () => {
    expect(mcpLaunchStale(null, EXPECTED)).toBe(false);
  });

  // 烟测与 e2e 用 ATM_DATA_DIR 指到临时目录，而修复写的是全局 Agent 配置。
  // 不挡住的话，跑完一次烟测就把用户的配置改成指向一个已被删除的临时目录——
  // 自己制造出这次要修的那个故障。
  it("数据根被 ATM_DATA_DIR 改过时不自动修复", () => {
    expect(shouldRepairMcpConfigs({} as NodeJS.ProcessEnv)).toBe(true);
    expect(shouldRepairMcpConfigs({ ATM_DATA_DIR: "C:\\temp\\smoke" } as NodeJS.ProcessEnv)).toBe(
      false,
    );
  });

  it("开发态默认数据根不覆盖正式 current 与 Agent 配置", () => {
    const normal = {} as NodeJS.ProcessEnv;
    const isolated = { ATM_DATA_DIR: "C:\\temp\\dev-data" } as NodeJS.ProcessEnv;

    expect(shouldManageMcpRuntime(false, normal)).toBe(false);
    expect(shouldRepairMcpConfigs(normal, false)).toBe(false);
    expect(shouldManageMcpRuntime(false, isolated)).toBe(true);
    expect(shouldManageMcpRuntime(true, normal)).toBe(true);
    expect(shouldRepairMcpConfigs(normal, true)).toBe(true);
  });

  it("打包烟测只能在全部 Agent 配置根都被隔离时显式开启修复", () => {
    const isolated = {
      ATM_DATA_DIR: "C:\\temp\\smoke\\data",
      ATM_PACKAGED_SMOKE: "1",
      ATM_SMOKE_MCP_CONFIG_REPAIR: "1",
      ATM_SMOKE_AGENT_CONFIG_ROOT: "C:\\temp\\smoke\\agents",
      APPDATA: "C:\\temp\\smoke\\agents\\Roaming",
      LOCALAPPDATA: "C:\\temp\\smoke\\agents\\Local",
      USERPROFILE: "C:\\temp\\smoke\\agents\\Home",
    } as NodeJS.ProcessEnv;
    expect(shouldRepairMcpConfigs(isolated)).toBe(true);
    expect(shouldRepairMcpConfigs({ ...isolated, APPDATA: "C:\\Users\\real\\AppData" })).toBe(
      false,
    );
    expect(shouldRepairMcpConfigs({ ...isolated, ATM_SMOKE_MCP_CONFIG_REPAIR: undefined })).toBe(
      false,
    );
  });
});

// 修复改成每次启动自动跑之后，「写进去 → 读回来 → 判定一致」必须严丝合缝。
// 差一个字节就会每启动一次重写一次，而每次重写都留一份 .bak——实测 ~/.codex
// 已经攒了 33 个，那还只是手动安装攒出来的。
describe("修复的幂等性", () => {
  const profileExpected = {
    core: { ...EXPECTED, args: [...EXPECTED.args, "--profile", "core"] },
    memory: { ...EXPECTED, args: [...EXPECTED.args, "--profile", "memory"] },
    actions: { ...EXPECTED, args: [...EXPECTED.args, "--profile", "actions"] },
  };

  it("Codex：修一次之后不再判为过期，别人的段不受影响", () => {
    const path = join(scratch(), "config.toml");
    writeFileSync(
      path,
      [
        'model = "gpt"',
        "",
        '[mcp_servers."ayanami-task-manager"]',
        `command = ${JSON.stringify(PINNED.command)}`,
        `args = [${JSON.stringify(PINNED.args[0])}]`,
        'env = { "ELECTRON_RUN_AS_NODE" = "1" }',
        "",
      ].join("\n"),
      "utf8",
    );
    expect(mcpProfileLaunchesStale(installedCodexProfileLaunches(path), profileExpected)).toBe(
      true,
    );

    installCodexConfig({ path, ...EXPECTED });
    expect(mcpProfileLaunchesStale(installedCodexProfileLaunches(path), profileExpected)).toBe(
      false,
    );
    expect(readFileSync(path, "utf8")).toContain('model = "gpt"');
  });

  it("Claude Desktop：修一次之后不再判为过期，别人的 server 不受影响", () => {
    const path = join(scratch(), "claude_desktop_config.json");
    writeFileSync(
      path,
      `${JSON.stringify({
        mcpServers: { other: { command: "other.exe" }, "ayanami-task-manager": PINNED },
      })}\n`,
      "utf8",
    );
    expect(mcpProfileLaunchesStale(installedClaudeProfileLaunches(path), profileExpected)).toBe(
      true,
    );

    installClaudeConfig({ path, ...EXPECTED });
    expect(mcpProfileLaunchesStale(installedClaudeProfileLaunches(path), profileExpected)).toBe(
      false,
    );
    expect(readFileSync(path, "utf8")).toContain("other.exe");
  });
});

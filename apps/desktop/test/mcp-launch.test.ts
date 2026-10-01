import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  installMcpStdioBridge,
  mcpLaunch,
  mcpNodeBridgeLaunch,
  mcpProfileLaunchesStale,
  mcpProfileLaunches,
  mcpLaunchStale,
  mcpStdioHttpPath,
  MCP_RUNTIME_LINK,
  MCP_SHIM_FILENAME,
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

/**
 * 原生安装：安装根放启动器（无界面命令转给当前版本的宿主）与稳定的 resources\atm-mcp.exe，
 * 宿主在 app-<version> 里。`shim` 为真时两处都放 shim（安装事务从版本目录复制到安装根）。
 */
function nativeInstall(
  versions: string[],
  { shim = false }: { shim?: boolean } = {},
): { installRoot: string; execPaths: string[] } {
  const installRoot = scratch();
  writeFileSync(join(installRoot, "AyanamiTaskManager.exe"), "launcher", "utf8");
  mkdirSync(join(installRoot, "resources"), { recursive: true });
  if (shim) writeFileSync(join(installRoot, "resources", MCP_SHIM_FILENAME), "shim", "utf8");
  const execPaths = versions.map((version) => {
    mkdirSync(join(installRoot, `app-${version}`, "resources"), { recursive: true });
    const execPath = join(installRoot, `app-${version}`, "AyanamiTaskManager.exe");
    writeFileSync(execPath, "host", "utf8");
    if (shim)
      writeFileSync(
        join(installRoot, `app-${version}`, "resources", MCP_SHIM_FILENAME),
        "shim",
        "utf8",
      );
    return execPath;
  });
  return { installRoot, execPaths };
}

/** 安装事务做的事：数据根下的 current 指向安装根。 */
function linkCurrent(installRoot: string, dataDir: string): void {
  symlinkSync(installRoot, join(dataDir, MCP_RUNTIME_LINK), "junction");
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
  it("没有 shim 时 command 是链接下的启动器 --mcp-stdio，不带 app-<version> 与环境变量", () => {
    const { installRoot, execPaths } = nativeInstall([FIXTURE_VERSION]);
    const execPath = execPaths[0]!;
    const dataDir = scratch();
    linkCurrent(installRoot, dataDir);
    const launch = mcpLaunch({ execPath, dataDir });

    expect(launch).toEqual({
      command: join(dataDir, MCP_RUNTIME_LINK, "AyanamiTaskManager.exe"),
      args: ["--mcp-stdio"],
      env: {},
    });
    expect(launch.command).not.toContain(`app-${FIXTURE_VERSION}`);
    // 穿透之后是安装根的启动器：它把 --mcp-stdio 当无界面命令转给当前版本，并等它退出。
    expect(readFileSync(launch.command, "utf8")).toBe("launcher");
  });

  // 换版本对配置是零改动，也就没有需要客户端配合的时机。
  it("换了版本目录，启动方式一字不变，也不判为过期", () => {
    const { installRoot, execPaths } = nativeInstall(["1.0.1", "1.0.2"]);
    const dataDir = scratch();
    linkCurrent(installRoot, dataDir);
    const before = mcpLaunch({ execPath: execPaths[0]!, dataDir });
    const after = mcpLaunch({ execPath: execPaths[1]!, dataDir });

    expect(after).toEqual(before);
    expect(mcpLaunchStale(before, after)).toBe(false);
  });

  it("链接还没建（开发态）时用宿主的真实路径", () => {
    const { execPaths } = nativeInstall([FIXTURE_VERSION]);
    const execPath = execPaths[0]!;
    expect(mcpLaunch({ execPath, dataDir: scratch() })).toEqual({
      command: execPath,
      args: ["--mcp-stdio"],
      env: {},
    });
  });

  // 这条链接指向的是**安装根**。数据根被递归删除的场合到处都是（烟测的临时数据根、
  // 用户清数据），只要哪个删除动作穿透了链接，删掉的就是用户装好的应用。
  it("递归删掉数据根不会穿透链接删掉安装目录", () => {
    const { installRoot, execPaths } = nativeInstall([FIXTURE_VERSION]);
    const dataDir = scratch();
    linkCurrent(installRoot, dataDir);

    rmSync(dataDir, { recursive: true, force: true });

    expect({ dataDir: existsSync(dataDir), exe: existsSync(execPaths[0]!) }).toEqual({
      dataDir: false,
      exe: true,
    });
    expect(existsSync(join(installRoot, "AyanamiTaskManager.exe"))).toBe(true);
  });

  it("为同一个入口生成固定 core / memory / actions 启动参数", () => {
    const { installRoot, execPaths } = nativeInstall([FIXTURE_VERSION]);
    const dataDir = scratch();
    linkCurrent(installRoot, dataDir);
    const launches = mcpProfileLaunches({ execPath: execPaths[0]!, dataDir });
    const command = join(dataDir, MCP_RUNTIME_LINK, "AyanamiTaskManager.exe");

    for (const profile of ["core", "memory", "actions"] as const)
      expect(launches[profile]).toEqual({
        command,
        args: ["--mcp-stdio", "--profile", profile],
        env: {},
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
    expect(
      shouldRepairMcpConfigs({
        ATM_DATA_DIR: "C:\\temp\\smoke",
        LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  // 原生宿主总会把解析好的数据根交给 core；是不是产品数据根由宿主判定后经
  // ATM_PRODUCT_DATA_ROOT 告诉 core，core 不拿可被沙箱替换的 LOCALAPPDATA 自证。
  it("宿主判定为产品数据根时照常修复；只凭路径相等、源码运行或烟测都不行", () => {
    const local = "C:\\Users\\u\\AppData\\Local";
    const productRoot = `${local}\\AyanamiTaskManager`;
    const host = { ATM_DATA_DIR: productRoot, LOCALAPPDATA: local } as NodeJS.ProcessEnv;
    expect(shouldRepairMcpConfigs({ ...host, ATM_PRODUCT_DATA_ROOT: "1" }, true)).toBe(true);
    // 路径和 LOCALAPPDATA 对得上，但宿主没有确认（例如只把 LOCALAPPDATA 换成了沙箱）。
    expect(shouldRepairMcpConfigs(host, true)).toBe(false);
    // 源码运行的宿主同样会给默认根。
    expect(shouldRepairMcpConfigs({ ...host, ATM_PRODUCT_DATA_ROOT: "1" }, false)).toBe(false);
    // 烟测标记压过一切捷径：配置根没全隔离就不修。
    expect(
      shouldRepairMcpConfigs(
        {
          ...host,
          ATM_PRODUCT_DATA_ROOT: "1",
          ATM_PACKAGED_SMOKE: "1",
          ATM_SMOKE_MCP_CONFIG_REPAIR: "1",
          ATM_SMOKE_AGENT_CONFIG_ROOT: "C:\\temp\\smoke\\agents",
          APPDATA: "C:\\Users\\u\\AppData\\Roaming",
          USERPROFILE: "C:\\Users\\u",
        },
        true,
      ),
    ).toBe(false);
    // 宿主只在没有继承覆盖、LOCALAPPDATA 等于系统已知文件夹时才设它，并清掉继承来的同名变量。
    const core = readFileSync(
      join(process.cwd(), "apps/desktop/native/host/src/core_process.rs"),
      "utf8",
    );
    expect(core).toContain('process.env("ATM_DATA_DIR", data_dir);');
    expect(core).toContain("if product_default_data_root(data_dir) {");
    expect(core).toContain("crate::win::known_local_app_data()");
    expect(core).toContain("|| upper == PRODUCT_DATA_ROOT");
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

// 原生 shim 做 stdio 转发。它必须走同一个版本无关链接、不带任何环境变量，缺失时回落到
// 宿主的 --mcp-stdio；每个方向的切换都必须被启动时的过期修复识别出来。
describe("原生 shim 优先", () => {
  const profiles = (launch: { command: string; args: string[]; env: Record<string, string> }) => ({
    core: { ...launch, args: [...launch.args, "--profile", "core"] },
    memory: { ...launch, args: [...launch.args, "--profile", "memory"] },
    actions: { ...launch, args: [...launch.args, "--profile", "actions"] },
  });

  it("装了 shim：command 走链接下的 current\\resources\\atm-mcp.exe，args 为空，无 env", () => {
    const { installRoot, execPaths } = nativeInstall([FIXTURE_VERSION], { shim: true });
    const dataDir = scratch();
    linkCurrent(installRoot, dataDir);

    const launch = mcpLaunch({ execPath: execPaths[0]!, dataDir });
    expect(launch).toEqual({
      command: join(dataDir, MCP_RUNTIME_LINK, "resources", MCP_SHIM_FILENAME),
      args: [],
      env: {},
    });
    expect(launch.command).not.toContain(`app-${FIXTURE_VERSION}`);
    expect(readFileSync(launch.command, "utf8")).toBe("shim");
  });

  // agent-config 在 args 缺省时补 `--mcp-stdio`（宿主的开关）。shim 不认识它，
  // 所以 args 必须是空数组；写入器最终拼出来的参数由下面的幂等用例经真实写入钉住。
  it("三个 Profile 的参数只有 --profile，不带桥脚本路径与环境变量", () => {
    const { installRoot, execPaths } = nativeInstall([FIXTURE_VERSION], { shim: true });
    const dataDir = scratch();
    linkCurrent(installRoot, dataDir);
    expect(mcpLaunch({ execPath: execPaths[0]!, dataDir }).args).toEqual([]);
    const launches = mcpProfileLaunches({ execPath: execPaths[0]!, dataDir });

    for (const profile of ["core", "memory", "actions"] as const) {
      expect(launches[profile].args).toEqual(["--profile", profile]);
      expect(launches[profile].env).toEqual({});
    }
  });

  it("链接还没建时用版本目录里的 shim", () => {
    const { execPaths } = nativeInstall([FIXTURE_VERSION], { shim: true });
    const execPath = execPaths[0]!;
    expect(mcpLaunch({ execPath, dataDir: scratch() })).toEqual({
      command: join(dirname(execPath), "resources", MCP_SHIM_FILENAME),
      args: [],
      env: {},
    });
  });

  it("shim 不在（开发态、被杀毒软件隔离）时回落到宿主的 --mcp-stdio，绝不再写 Electron-as-node", () => {
    const { installRoot, execPaths } = nativeInstall([FIXTURE_VERSION]);
    const dataDir = scratch();
    linkCurrent(installRoot, dataDir);

    const launch = mcpLaunch({ execPath: execPaths[0]!, dataDir });
    expect(launch).toEqual({
      command: join(dataDir, MCP_RUNTIME_LINK, "AyanamiTaskManager.exe"),
      args: ["--mcp-stdio"],
      env: {},
    });
    // 旧形式只用来认出还握着 1.x 配置的会话。
    const legacy = mcpNodeBridgeLaunch({ execPath: execPaths[0]!, dataDir });
    expect(legacy.command).toBe(launch.command);
    expect(legacy).toEqual({
      command: launch.command,
      args: [join(dataDir, MCP_STDIO_FILENAME)],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
  });

  // 存量迁移靠的就是这条：从 1.x 升上来第一次启动，旧 JS 桥配置判为过期、被改写成 shim；
  // shim 被删之后再启动，shim 配置判为过期、被改成宿主的 --mcp-stdio。
  it("切换都判为过期，写完之后都不再过期", () => {
    const { installRoot, execPaths } = nativeInstall([FIXTURE_VERSION], { shim: true });
    const execPath = execPaths[0]!;
    const dataDir = scratch();
    linkCurrent(installRoot, dataDir);
    const shimLaunch = mcpLaunch({ execPath, dataDir });
    const legacyLaunch = mcpNodeBridgeLaunch({ execPath, dataDir });
    const path = join(scratch(), "config.toml");

    installCodexConfig({ path, ...legacyLaunch });
    expect(mcpProfileLaunchesStale(installedCodexProfileLaunches(path), profiles(shimLaunch))).toBe(
      true,
    );
    installCodexConfig({ path, ...shimLaunch });
    expect(mcpProfileLaunchesStale(installedCodexProfileLaunches(path), profiles(shimLaunch))).toBe(
      false,
    );

    rmSync(join(installRoot, "resources", MCP_SHIM_FILENAME));
    const fallback = mcpLaunch({ execPath, dataDir });
    expect(fallback.args).toEqual(["--mcp-stdio"]);
    expect(mcpProfileLaunchesStale(installedCodexProfileLaunches(path), profiles(fallback))).toBe(
      true,
    );
    installCodexConfig({ path, ...fallback });
    expect(mcpProfileLaunchesStale(installedCodexProfileLaunches(path), profiles(fallback))).toBe(
      false,
    );
  });

  // 空 env 最容易在「写进去 → 读回来」之间差一个字节：TOML 不写 env 行、JSON 写成 {}，
  // 读回来要都等于 {}。差了就是每次启动都重写一次、每次留一份 .bak。
  it("shim 配置写入后读回逐字一致：Codex 与 Claude Desktop 都不会被反复重写", () => {
    const { installRoot, execPaths } = nativeInstall([FIXTURE_VERSION], { shim: true });
    const dataDir = scratch();
    linkCurrent(installRoot, dataDir);
    const shimLaunch = mcpLaunch({ execPath: execPaths[0]!, dataDir });

    const codex = join(scratch(), "config.toml");
    installCodexConfig({ path: codex, ...shimLaunch });
    expect(
      mcpProfileLaunchesStale(installedCodexProfileLaunches(codex), profiles(shimLaunch)),
    ).toBe(false);
    const toml = readFileSync(codex, "utf8");
    expect(toml).not.toContain("ELECTRON_RUN_AS_NODE");
    expect(toml).not.toContain("--mcp-stdio");
    expect(toml).not.toContain(MCP_STDIO_FILENAME);

    const claude = join(scratch(), "claude_desktop_config.json");
    installClaudeConfig({ path: claude, ...shimLaunch });
    expect(
      mcpProfileLaunchesStale(installedClaudeProfileLaunches(claude), profiles(shimLaunch)),
    ).toBe(false);
    const json = JSON.parse(readFileSync(claude, "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
    };
    for (const server of Object.values(json.mcpServers)) {
      expect(server.command).toBe(shimLaunch.command);
      expect(server.args[0]).toBe("--profile");
      expect(server.env ?? {}).toEqual({});
    }
  });

  // Agent 读着 Guide 手工配置时，写出来的东西必须和 ATM 自己安装的一模一样。
  it("Guide 与便携说明里的手工配置就是 mcpLaunch 在装了 shim 时的产出", () => {
    const shimPath = `%LOCALAPPDATA%\\AyanamiTaskManager\\${MCP_RUNTIME_LINK}\\resources\\${MCP_SHIM_FILENAME}`;
    const guide = readFileSync("ATM_AGENT_GUIDE.md", "utf8");
    const commands = guide.match(/^claude mcp add-json .*$/gmu) ?? [];
    expect(commands).toHaveLength(3);
    for (const [index, profile] of ["core", "memory", "actions"].entries()) {
      const json = /'(\{.*\})'/u.exec(commands[index] ?? "")?.[1] ?? "{}";
      expect(JSON.parse(json)).toEqual({ command: "<atm-mcp.exe>", args: ["--profile", profile] });
    }
    expect(guide).toContain(`\`<atm-mcp.exe>\` 是 \`${shimPath}\``);
    // 便携版没有安装事务建的 current 链接，mcpLaunch 落在解压目录本身。
    const portable = readFileSync("docs/portable-usage.md", "utf8");
    expect(portable).toContain(`命令指向解压目录下的 \`resources\\${MCP_SHIM_FILENAME}\``);
    expect(portable).not.toContain(shimPath);
    // shim 缺失时的回落就是 mcpLaunch 的另一支：宿主自己的 --mcp-stdio，不带环境变量。
    expect(guide).toContain(
      '`{"command":"<ATM.exe>","args":["--mcp-stdio","--profile","core"]}`，`<ATM.exe>` 是 ' +
        `\`%LOCALAPPDATA%\\AyanamiTaskManager\\${MCP_RUNTIME_LINK}\\AyanamiTaskManager.exe\``,
    );
    expect(readFileSync("docs/troubleshooting.md", "utf8")).toContain(
      `使用 \`${shimPath}\`，参数只有 \`--profile <name>\`，不带环境变量`,
    );
  });
});

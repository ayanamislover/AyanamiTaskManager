import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installClaudeConfig,
  installCodexConfig,
  installedClaudeLaunch,
  installedCodexLaunch,
} from "@ayanami-task/agent-config";
import {
  installMcpStdioBridge,
  mcpLaunch,
  mcpLaunchStale,
  MCP_STDIO_FILENAME,
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
  // 这条是本次缺陷的核心不变量。配置里只要留下一个 app-<version>，下一次自更新
  // 就把它指向一个不存在的文件——表现是「Agent 连不上」，而应用本身一切正常，
  // 没人会想到去看配置里那串版本号。实测配置停在 1.0.3、应用已经 1.0.10。
  it("产出的路径里不含任何版本号目录", () => {
    const { installRoot, execPath } = squirrelInstall("1.0.10");
    const dataDir = scratch();
    const launch = mcpLaunch({ execPath, dataDir });

    for (const path of [launch.command, ...launch.args]) {
      expect({ path, pinned: path.includes("app-1.0.10") }).toEqual({ path, pinned: false });
    }
    expect(launch.command).toBe(join(installRoot, "AyanamiTaskManager.exe"));
    expect(launch.args).toEqual([join(dataDir, MCP_STDIO_FILENAME)]);
    expect(launch.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  });

  // portable 不是 Squirrel 安装，没有启动壳。猜错方向会写出一个根本不存在的
  // command，比版本钉死还糟——所以两个文件都在才认。
  it("没有 Squirrel 启动壳时退回 execPath", () => {
    const root = scratch();
    mkdirSync(join(root, "AyanamiTaskManager-win32-x64"), { recursive: true });
    const execPath = join(root, "AyanamiTaskManager-win32-x64", "AyanamiTaskManager.exe");
    writeFileSync(execPath, "portable", "utf8");
    const dataDir = scratch();
    expect(mcpLaunch({ execPath, dataDir }).command).toBe(execPath);

    // 只有壳、没有 Update.exe 也不算：那可能是任何一个同名文件。
    const half = squirrelInstall("1.0.10");
    rmSync(join(half.installRoot, "Update.exe"), { force: true });
    expect(mcpLaunch({ execPath: half.execPath, dataDir }).command).toBe(half.execPath);
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
  it("命令或参数对不上就算过期，一致就不动", () => {
    expect(mcpLaunchStale({ command: EXPECTED.command, args: [...EXPECTED.args] }, EXPECTED)).toBe(
      false,
    );
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
});

// 修复改成每次启动自动跑之后，「写进去 → 读回来 → 判定一致」必须严丝合缝。
// 差一个字节就会每启动一次重写一次，而每次重写都留一份 .bak——实测 ~/.codex
// 已经攒了 33 个，那还只是手动安装攒出来的。
describe("修复的幂等性", () => {
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
    expect(mcpLaunchStale(installedCodexLaunch(path), EXPECTED)).toBe(true);

    installCodexConfig({ path, ...EXPECTED });
    expect(mcpLaunchStale(installedCodexLaunch(path), EXPECTED)).toBe(false);
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
    expect(mcpLaunchStale(installedClaudeLaunch(path), EXPECTED)).toBe(true);

    installClaudeConfig({ path, ...EXPECTED });
    expect(mcpLaunchStale(installedClaudeLaunch(path), EXPECTED)).toBe(false);
    expect(readFileSync(path, "utf8")).toContain("other.exe");
  });
});

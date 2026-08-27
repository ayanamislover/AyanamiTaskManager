import { describe, expect, it } from "vitest";
import { mcpProfileLaunches, mcpProfileLaunchesStale } from "../src/mcp-launch.js";

const EXPECTED = mcpProfileLaunches({
  execPath: "C:\\ATM\\current\\AyanamiTaskManager.exe",
  dataDir: "C:\\ATM\\data",
});

const NONE = { legacy: null, core: null, memory: null, actions: null } as const;
const core = () => ({
  command: EXPECTED.core.command,
  args: [...EXPECTED.core.args],
  env: { ...EXPECTED.core.env },
});
const memory = () => ({
  command: EXPECTED.memory.command,
  args: [...EXPECTED.memory.args],
  env: { ...EXPECTED.memory.env },
});
const actions = () => ({
  command: EXPECTED.actions.command,
  args: [...EXPECTED.actions.args],
  env: { ...EXPECTED.actions.env },
});

/** 默认三入口；显式 core-only 是用户主动选择的低内存降级，启动修复不得擅自反转。 */
describe("MCP profile 过期判据跟随启用集合", () => {
  it("一个都没装就不算过期——没装是用户没装，不能借修复替他装上", () => {
    expect(mcpProfileLaunchesStale(NONE, EXPECTED, ["core"])).toBe(false);
    expect(mcpProfileLaunchesStale(NONE, EXPECTED, ["core", "memory"])).toBe(false);
    expect(mcpProfileLaunchesStale(NONE, EXPECTED)).toBe(false);
  });

  it("只残留 actions 也属于已安装但过期，不能误判成从未安装", () => {
    expect(
      mcpProfileLaunchesStale(
        { legacy: null, core: null, memory: null, actions: actions() },
        EXPECTED,
      ),
    ).toBe(true);
  });

  it("只启用 core 且只装了 core 时不过期", () => {
    expect(
      mcpProfileLaunchesStale({ legacy: null, core: core(), memory: null }, EXPECTED, ["core"]),
    ).toBe(false);
  });

  it("关掉 memory 之后它还登记着，必须判过期去移除", () => {
    expect(
      mcpProfileLaunchesStale({ legacy: null, core: core(), memory: memory() }, EXPECTED, ["core"]),
    ).toBe(true);
  });

  it("启用 memory 但没登记，判过期去补上", () => {
    expect(
      mcpProfileLaunchesStale({ legacy: null, core: core(), memory: null }, EXPECTED, [
        "core",
        "memory",
      ]),
    ).toBe(true);
  });

  it("两个都启用且都登记正确时不过期", () => {
    expect(
      mcpProfileLaunchesStale({ legacy: null, core: core(), memory: memory() }, EXPECTED, [
        "core",
        "memory",
      ]),
    ).toBe(false);
  });

  it("legacy 还留着一律判过期", () => {
    expect(
      mcpProfileLaunchesStale(
        { legacy: { command: "old.exe", args: [] }, core: core(), memory: null },
        EXPECTED,
        ["core"],
      ),
    ).toBe(true);
  });

  it("启动方式变了（版本目录换了）仍然判过期", () => {
    expect(
      mcpProfileLaunchesStale(
        {
          legacy: null,
          core: { command: "C:\\ATM\\app-1.0.12\\AyanamiTaskManager.exe", args: [...core().args] },
          memory: null,
        },
        EXPECTED,
        ["core"],
      ),
    ).toBe(true);
  });

  it("Electron Node bridge 环境变量缺失或写错时不能假绿", () => {
    expect(
      mcpProfileLaunchesStale(
        { legacy: null, core: { command: core().command, args: core().args }, memory: null },
        EXPECTED,
        ["core"],
      ),
    ).toBe(true);
    expect(
      mcpProfileLaunchesStale(
        {
          legacy: null,
          core: { ...core(), env: { ELECTRON_RUN_AS_NODE: "0" } },
          memory: null,
        },
        EXPECTED,
        ["core"],
      ),
    ).toBe(true);
  });

  it("漏传启用集合时按默认三入口处理", () => {
    expect(
      mcpProfileLaunchesStale(
        { legacy: null, core: core(), memory: memory(), actions: actions() },
        EXPECTED,
      ),
    ).toBe(false);
    expect(mcpProfileLaunchesStale({ legacy: null, core: core(), memory: null }, EXPECTED)).toBe(
      true,
    );
  });
});

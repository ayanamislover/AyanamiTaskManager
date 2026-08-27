import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MCP_PROFILES,
  enabledMcpProfiles,
  installClaudeCodeConfig,
  installClaudeConfig,
  installCodexConfig,
  isClaudeCodeConfigInstalled,
  isClaudeConfigInstalled,
  isCodexConfigInstalled,
  installedCodexProfileLaunches,
  MCP_SERVER_NAMES,
  renderMcpConfigs,
} from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(root);
  return root;
}

const WRITE = {
  command: "C:\\ATM\\current\\AyanamiTaskManager.exe",
  args: ["C:\\ATM\\data\\mcp-stdio.cjs"],
  env: { ELECTRON_RUN_AS_NODE: "1" },
};

function claudeServers(path: string): Record<string, unknown> {
  return (JSON.parse(readFileSync(path, "utf8")) as { mcpServers: Record<string, unknown> })
    .mcpServers;
}

/**
 * 新版默认提供完整的 core + memory + actions 工具面；用户仍可显式切到 core-only。
 * core 永远不可关闭，显式关闭 memory 必须真正从客户端配置移除，而不是只改界面状态。
 */
describe("MCP profile 默认完整入口并支持显式 core-only", () => {
  it("默认启用集合包含 core、memory 与 actions，且 core 关不掉", () => {
    expect([...DEFAULT_MCP_PROFILES]).toEqual(["core", "memory", "actions"]);
    expect(enabledMcpProfiles()).toEqual(["core", "memory", "actions"]);
    expect(enabledMcpProfiles([])).toEqual(["core"]);
    // 只传 memory 也要把 core 补回来：没有 core 的 ATM 没有任何入口，
    // 那只可能是调用方漏了，不是用户想要一个空壳。
    expect(enabledMcpProfiles(["memory"])).toEqual(["core", "memory"]);
    expect(enabledMcpProfiles(["core", "memory"])).toEqual(["core", "memory"]);
  });

  it("Codex：默认写双入口，显式 core-only 才移除 memory", () => {
    const path = join(scratch("atm-optin-codex-"), "config.toml");
    installCodexConfig({ ...WRITE, path });
    const byDefault = readFileSync(path, "utf8");
    expect(byDefault).toContain(MCP_SERVER_NAMES.core);
    expect(byDefault).toContain(MCP_SERVER_NAMES.memory);
    expect(byDefault).toContain('"--profile", "core"');
    expect(isCodexConfigInstalled(path)).toBe(true);

    installCodexConfig({ ...WRITE, path, profiles: ["core"] });
    const reduced = readFileSync(path, "utf8");
    expect(reduced).not.toContain(MCP_SERVER_NAMES.memory);
    expect(isCodexConfigInstalled(path, ["core"])).toBe(true);
  });

  it("Codex：显式关闭后可按默认值恢复完整双入口", () => {
    const path = join(scratch("atm-optin-codex-off-"), "config.toml");
    installCodexConfig({ ...WRITE, path, profiles: ["core"] });
    expect(readFileSync(path, "utf8")).not.toContain(MCP_SERVER_NAMES.memory);

    installCodexConfig({ ...WRITE, path });
    const restored = readFileSync(path, "utf8");
    expect(restored).toContain(MCP_SERVER_NAMES.core);
    expect(restored).toContain(MCP_SERVER_NAMES.memory);
  });

  it("Codex：迁移旧单入口时连受管 TOML 子表一起移除", () => {
    const path = join(scratch("atm-optin-codex-subtable-"), "config.toml");
    writeFileSync(
      path,
      [
        '[mcp_servers."ayanami-task-manager"]',
        'command = "old.exe"',
        '[mcp_servers."ayanami-task-manager".env]',
        'OLD_TOKEN = "must-disappear"',
        "[mcp_servers.other]",
        'command = "keep.exe"',
        "",
      ].join("\n"),
    );

    installCodexConfig({ ...WRITE, path });

    const migrated = readFileSync(path, "utf8");
    expect(migrated).not.toContain('mcp_servers."ayanami-task-manager"');
    expect(migrated).not.toContain("OLD_TOKEN");
    expect(migrated).toContain("[mcp_servers.other]");
    expect(migrated).toContain(MCP_SERVER_NAMES.core);
    expect(migrated).toContain(MCP_SERVER_NAMES.memory);
    expect(isCodexConfigInstalled(path)).toBe(true);
    expect(installedCodexProfileLaunches(path).core?.env).toEqual(WRITE.env);
  });

  it("Claude Desktop：默认写双入口，显式降级会移除 memory 且不动别人的 server", () => {
    const path = join(scratch("atm-optin-claude-"), "claude_desktop_config.json");
    writeFileSync(path, `${JSON.stringify({ mcpServers: { other: { command: "keep.exe" } } })}\n`);

    installClaudeConfig({ ...WRITE, path });
    expect(Object.keys(claudeServers(path)).sort()).toEqual([
      MCP_SERVER_NAMES.actions,
      MCP_SERVER_NAMES.core,
      MCP_SERVER_NAMES.memory,
      "other",
    ]);

    installClaudeConfig({ ...WRITE, path, profiles: ["core"] });
    expect(Object.keys(claudeServers(path)).sort()).toEqual([MCP_SERVER_NAMES.core, "other"]);
  });

  it("Claude Code：显式 core-only 会 remove 掉 memory", () => {
    const root = scratch("atm-optin-claude-code-");
    const path = join(root, ".claude.json");
    writeFileSync(
      path,
      `${JSON.stringify({
        mcpServers: {
          [MCP_SERVER_NAMES.core]: { command: "old.exe", args: [] },
          [MCP_SERVER_NAMES.memory]: { command: "old.exe", args: [] },
        },
      })}\n`,
    );
    const calls: Array<{ args: string[] }> = [];
    installClaudeCodeConfig({
      ...WRITE,
      cliPath: "C:\\fake\\claude.exe",
      configPath: path,
      profiles: ["core"],
      runCli: (_cli, args) => calls.push({ args }),
    });
    const removed = calls.filter((call) => call.args[1] === "remove").map((call) => call.args[2]);
    const added = calls.filter((call) => call.args[1] === "add-json").map((call) => call.args[2]);
    expect(removed).toContain(MCP_SERVER_NAMES.memory);
    expect(added).toEqual([MCP_SERVER_NAMES.core]);
  });

  it("Claude Code：只剩 core 且显式 core-only 时判为已装，不再反复重写", () => {
    const root = scratch("atm-optin-claude-code-idempotent-");
    const path = join(root, ".claude.json");
    writeFileSync(
      path,
      `${JSON.stringify({
        mcpServers: {
          [MCP_SERVER_NAMES.core]: {
            command: WRITE.command,
            args: [...WRITE.args, "--profile", "core"],
            env: WRITE.env,
          },
        },
      })}\n`,
    );
    const calls: string[][] = [];
    installClaudeCodeConfig({
      ...WRITE,
      cliPath: "C:\\fake\\claude.exe",
      configPath: path,
      profiles: ["core"],
      runCli: (_cli, args) => calls.push(args),
    });
    expect(calls).toEqual([]);
    expect(isClaudeCodeConfigInstalled(path, ["core"])).toBe(true);
  });

  it("「已安装」是精确匹配：显式 core-only 时多一个 memory 也算没配好", () => {
    const codexPath = join(scratch("atm-optin-exact-codex-"), "config.toml");
    installCodexConfig({ ...WRITE, path: codexPath });
    // 装了两个、但只启用 core —— 必须判为「没配好」，否则界面一直显示已安装，
    // 用户没有任何入口去掉多出来的那个 server。
    expect(isCodexConfigInstalled(codexPath)).toBe(true);
    expect(isCodexConfigInstalled(codexPath, ["core"])).toBe(false);

    const claudePath = join(scratch("atm-optin-exact-claude-"), "claude_desktop_config.json");
    installClaudeConfig({ ...WRITE, path: claudePath });
    expect(isClaudeConfigInstalled(claudePath)).toBe(true);
    expect(isClaudeConfigInstalled(claudePath, ["core"])).toBe(false);

    const codePath = join(scratch("atm-optin-exact-code-"), ".claude.json");
    writeFileSync(
      codePath,
      `${JSON.stringify({
        mcpServers: {
          [MCP_SERVER_NAMES.core]: { command: "x.exe" },
          [MCP_SERVER_NAMES.memory]: { command: "x.exe" },
          [MCP_SERVER_NAMES.actions]: { command: "x.exe" },
        },
      })}\n`,
    );
    expect(isClaudeCodeConfigInstalled(codePath)).toBe(true);
    expect(isClaudeCodeConfigInstalled(codePath, ["core"])).toBe(false);
  });

  it("给用户复制的配置文本默认完整，显式 core-only 时才隐藏 memory", () => {
    const runtime = { endpoint: "http://127.0.0.1:7777/", token: "t", ...WRITE };
    const byDefault = renderMcpConfigs(runtime);
    for (const rendered of [byDefault.streamableHttp, byDefault.stdio, byDefault.generic]) {
      expect(rendered).toContain(MCP_SERVER_NAMES.core);
      expect(rendered).toContain(MCP_SERVER_NAMES.memory);
      expect(rendered).toContain(MCP_SERVER_NAMES.actions);
    }
    const reduced = renderMcpConfigs(runtime, ["core"]);
    expect(reduced.streamableHttp).not.toContain(MCP_SERVER_NAMES.memory);
    expect(reduced.stdio).not.toContain(MCP_SERVER_NAMES.memory);
    expect(reduced.streamableHttp).not.toContain(MCP_SERVER_NAMES.actions);
    expect(reduced.stdio).not.toContain(MCP_SERVER_NAMES.actions);
  });
});

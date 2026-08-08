import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installClaudeConfig, installCodexConfig, renderMcpConfigs } from "../src/index.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Agent MCP 配置适配", () => {
  it("Codex 只合并自己的 TOML 段并备份旧文件", () => {
    const root = mkdtempSync(join(tmpdir(), "atm-codex-config-"));
    temporary.push(root);
    const path = join(root, "config.toml");
    writeFileSync(path, 'model = "gpt"\n\n[mcp_servers.other]\ncommand = "other.exe"\n', "utf8");
    const result = installCodexConfig({
      path,
      command: "C:\\Program Files\\ATM\\AyanamiTaskManager.exe",
    });
    const content = readFileSync(path, "utf8");
    expect(existsSync(result.backupPath!)).toBe(true);
    expect(content).toContain("[mcp_servers.other]");
    expect(content).toContain('[mcp_servers."ayanami-task-manager"]');
    expect(content).toContain('args = ["--mcp-stdio"]');
    installCodexConfig({ path, command: "C:\\ATM\\new.exe" });
    expect(
      readFileSync(path, "utf8").match(/\[mcp_servers\."ayanami-task-manager"\]/gu),
    ).toHaveLength(1);
  });

  it("Claude 保留其他 server 和顶层配置", () => {
    const root = mkdtempSync(join(tmpdir(), "atm-claude-config-"));
    temporary.push(root);
    const path = join(root, "claude_desktop_config.json");
    writeFileSync(
      path,
      JSON.stringify({ theme: "dark", mcpServers: { other: { command: "other" } } }),
      "utf8",
    );
    const result = installClaudeConfig({ path, command: "C:\\ATM\\AyanamiTaskManager.exe" });
    const content = JSON.parse(readFileSync(path, "utf8"));
    expect(existsSync(result.backupPath!)).toBe(true);
    expect(content.theme).toBe("dark");
    expect(content.mcpServers.other).toEqual({ command: "other" });
    expect(content.mcpServers["ayanami-task-manager"]).toEqual({
      command: "C:\\ATM\\AyanamiTaskManager.exe",
      args: ["--mcp-stdio"],
    });
  });

  it("生成 Streamable HTTP、stdio 和通用 JSON 配置", () => {
    const rendered = renderMcpConfigs({
      endpoint: "http://127.0.0.1:43210",
      token: "secret",
      command: "atm.exe",
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(rendered.streamableHttp).toContain("http://127.0.0.1:43210/mcp");
    expect(rendered.streamableHttp).toContain("Bearer secret");
    expect(rendered.stdio).toContain("--mcp-stdio");
    expect(rendered.stdio).toContain("ELECTRON_RUN_AS_NODE");
    expect(JSON.parse(rendered.generic).mcpServers["ayanami-task-manager"]).toBeTruthy();
  });
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectManagedAgentRule,
  inspectAgentSkills,
  installAgentSkills,
  installClaudeCodeConfig,
  installClaudeConfig,
  installCodexConfig,
  manageAgentRule,
  renderMcpConfigs,
  uninstallAgentSkills,
  uninstallClaudeCodeConfig,
  uninstallClaudeConfig,
  uninstallCodexConfig,
} from "../src/index.js";

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
    uninstallCodexConfig(path);
    expect(readFileSync(path, "utf8")).toContain("[mcp_servers.other]");
    expect(readFileSync(path, "utf8")).not.toContain("ayanami-task-manager");
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
    uninstallClaudeConfig(path);
    const removed = JSON.parse(readFileSync(path, "utf8"));
    expect(removed.theme).toBe("dark");
    expect(removed.mcpServers.other).toEqual({ command: "other" });
    expect(removed.mcpServers["ayanami-task-manager"]).toBeUndefined();
  });

  it("Claude Code 经 CLI 写 user scope，绝不自行改写 ~/.claude.json", () => {
    const root = mkdtempSync(join(tmpdir(), "atm-claude-code-config-"));
    temporary.push(root);
    const path = join(root, ".claude.json");
    // 这个文件平时由 Claude Code 持有，含大量会话状态；安装过程一个字节都不该动它。
    const original = JSON.stringify({
      projects: { "R:\\demo": { history: ["x"] } },
      mcpServers: { other: { command: "other" } },
    });
    writeFileSync(path, original, "utf8");

    const calls: Array<{ cli: string; args: string[] }> = [];
    const result = installClaudeCodeConfig({
      command: "C:\\ATM\\AyanamiTaskManager.exe",
      args: ["C:\\ATM\\resources\\mcp-stdio.cjs"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      cliPath: "C:\\fake\\claude.exe",
      configPath: path,
      runCli: (cli, args) => calls.push({ cli, args }),
    });

    expect(result.client).toBe("CLAUDE_CODE");
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cli).toBe("C:\\fake\\claude.exe");
    expect(calls[0]!.args.slice(0, 3)).toEqual(["mcp", "add-json", "ayanami-task-manager"]);
    expect(calls[0]!.args.slice(-2)).toEqual(["--scope", "user"]);
    const payload = JSON.parse(calls[0]!.args[3]!);
    // stdio 传输：不能把每次重启都会变的 endpoint / token 写死进配置。
    expect(payload).toEqual({
      command: "C:\\ATM\\AyanamiTaskManager.exe",
      args: ["C:\\ATM\\resources\\mcp-stdio.cjs"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(JSON.stringify(payload)).not.toContain("Bearer");
    expect(JSON.stringify(payload)).not.toContain("127.0.0.1");

    // 已安装时重复安装先移除再新增，保证幂等。
    writeFileSync(
      path,
      JSON.stringify({ mcpServers: { "ayanami-task-manager": { command: "old" } } }),
      "utf8",
    );
    calls.length = 0;
    installClaudeCodeConfig({
      command: "C:\\ATM\\new.exe",
      cliPath: "C:\\fake\\claude.exe",
      configPath: path,
      runCli: (cli, args) => calls.push({ cli, args }),
    });
    expect(calls.map((call) => call.args[1])).toEqual(["remove", "add-json"]);

    // 新配置注册失败时，必须仍通过 CLI 恢复旧 server，不能把现有接入删掉。
    calls.length = 0;
    expect(() =>
      installClaudeCodeConfig({
        command: "C:\\ATM\\broken.exe",
        cliPath: "C:\\fake\\claude.exe",
        configPath: path,
        runCli: (cli, args) => {
          calls.push({ cli, args });
          if (args[1] === "add-json" && JSON.parse(args[3]!).command === "C:\\ATM\\broken.exe") {
            throw new Error("new registration failed");
          }
        },
      }),
    ).toThrow("new registration failed");
    expect(calls.map((call) => call.args[1])).toEqual(["remove", "add-json", "add-json"]);
    expect(JSON.parse(calls[2]!.args[3]!)).toEqual({ command: "old" });

    // 未安装时卸载是空操作，不该白白调用 CLI。
    writeFileSync(path, JSON.stringify({ mcpServers: {} }), "utf8");
    calls.length = 0;
    uninstallClaudeCodeConfig({
      cliPath: "C:\\fake\\claude.exe",
      configPath: path,
      runCli: (cli, args) => calls.push({ cli, args }),
    });
    expect(calls).toHaveLength(0);
  });

  it("找不到 claude CLI 时报错，不退化成直接改写配置", () => {
    const root = mkdtempSync(join(tmpdir(), "atm-claude-code-nocli-"));
    temporary.push(root);
    const path = join(root, ".claude.json");
    const original = JSON.stringify({ mcpServers: { other: { command: "other" } } });
    writeFileSync(path, original, "utf8");
    let ran = false;
    expect(() =>
      installClaudeCodeConfig({
        command: "C:\\ATM\\AyanamiTaskManager.exe",
        configPath: path,
        // 模拟未安装 Claude Code 的机器；不能依赖真实探测，本机就装着 claude。
        findCli: () => null,
        runCli: () => {
          ran = true;
        },
      }),
    ).toThrow("CLAUDE_CODE_CLI_NOT_FOUND");
    expect(ran).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(original);
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
    expect(rendered.agentRule).toContain("%LOCALAPPDATA%\\AyanamiTaskManager\\ATM_AGENT_GUIDE.md");
    expect(rendered.agentRule).not.toContain("R:\\Project_All");
    expect(rendered.agentRule).toContain("后续所有任务执行均依赖 ATM");
    expect(rendered.agentRule).toContain("拆分成可独立验收的工作项");
  });

  it("只安装 ATM 管理的两个 Skill 并备份已有目录", () => {
    const root = mkdtempSync(join(tmpdir(), "atm-agent-skills-"));
    temporary.push(root);
    const sourceRoot = join(root, "published");
    const targetRoot = join(root, "host-skills");
    for (const name of ["atm-plan", "atm-task"]) {
      const directory = join(sourceRoot, name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8");
    }
    mkdirSync(join(sourceRoot, "_shared"), { recursive: true });
    writeFileSync(join(sourceRoot, "_shared", "planning-playbooks.md"), "# Playbooks\n", "utf8");
    mkdirSync(join(targetRoot, "atm-plan"), { recursive: true });
    writeFileSync(join(targetRoot, "atm-plan", "user-note.md"), "preserve me", "utf8");

    const installed = installAgentSkills({ sourceRoot, targetRoot });

    expect(installed.skills).toEqual(["atm-plan", "atm-task"]);
    expect(readFileSync(join(targetRoot, "atm-task", "SKILL.md"), "utf8")).toContain(
      "name: atm-task",
    );
    expect(readFileSync(join(targetRoot, "_shared", "planning-playbooks.md"), "utf8")).toContain(
      "Playbooks",
    );
    expect(installed.backupPaths).toHaveLength(1);
    expect(readFileSync(join(installed.backupPaths[0]!, "user-note.md"), "utf8")).toBe(
      "preserve me",
    );
    expect(inspectAgentSkills({ sourceRoot, targetRoot }).state).toBe("INSTALLED");
    writeFileSync(join(targetRoot, "_shared", "planning-playbooks.md"), "user modified", "utf8");
    expect(inspectAgentSkills({ sourceRoot, targetRoot }).skills).toContainEqual(
      expect.objectContaining({ name: "atm-plan", state: "MODIFIED" }),
    );
    writeFileSync(join(targetRoot, "atm-task", "SKILL.md"), "user modified", "utf8");
    expect(inspectAgentSkills({ sourceRoot, targetRoot }).state).toBe("MODIFIED");
    const removed = uninstallAgentSkills(targetRoot);
    expect(removed.backupPaths).toHaveLength(3);
    expect(existsSync(join(targetRoot, "atm-plan"))).toBe(false);
  });

  it("以 managed block 幂等安装规则并保留用户内容", () => {
    const root = mkdtempSync(join(tmpdir(), "atm-managed-rule-"));
    temporary.push(root);
    const path = join(root, "AGENTS.md");
    writeFileSync(path, "# My rules\n\nKeep this.\n", "utf8");

    const preview = manageAgentRule({ path, action: "PREVIEW" });
    expect(preview.state).toBe("NOT_INSTALLED");
    expect(readFileSync(path, "utf8")).toBe("# My rules\n\nKeep this.\n");
    expect(preview.proposed).toContain("ATM-INTEGRATION-VERSION: 1");

    manageAgentRule({ path, action: "INSTALL" });
    const once = readFileSync(path, "utf8");
    expect(once).toContain("# My rules");
    expect(once).toContain("AYANAMI_TASK_MANAGER:BEGIN");
    expect(inspectManagedAgentRule(path).state).toBe("INSTALLED");
    manageAgentRule({ path, action: "INSTALL" });
    expect(readFileSync(path, "utf8")).toBe(once);
  });

  it("检测用户修改并只在显式修复时覆盖，卸载仅移除 ATM block", () => {
    const root = mkdtempSync(join(tmpdir(), "atm-managed-rule-drift-"));
    temporary.push(root);
    const path = join(root, "CLAUDE.md");
    writeFileSync(path, "Personal rule.\n", "utf8");
    manageAgentRule({ path, action: "INSTALL" });
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "实际执行优先领取 READY",
        "用户修改：实际执行优先领取 READY",
      ),
      "utf8",
    );

    expect(inspectManagedAgentRule(path).state).toBe("MODIFIED");
    expect(() => manageAgentRule({ path, action: "UPDATE" })).toThrow(
      "AGENT_RULE_MODIFIED_REQUIRES_REPAIR",
    );
    manageAgentRule({ path, action: "REPAIR" });
    expect(inspectManagedAgentRule(path).state).toBe("INSTALLED");
    manageAgentRule({ path, action: "UNINSTALL" });
    expect(readFileSync(path, "utf8")).toBe("Personal rule.\n");
  });
});

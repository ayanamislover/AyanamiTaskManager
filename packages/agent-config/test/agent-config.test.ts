import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  isClaudeCodeConfigInstalled,
  isClaudeConfigInstalled,
  isCodexConfigInstalled,
  installedClaudeCodeLaunch,
  installedClaudeCodeProfileLaunches,
  installedClaudeLaunch,
  installedClaudeProfileLaunches,
  installedCodexLaunch,
  installedCodexProfileLaunches,
  BACKUP_RETENTION,
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

/** 双 Profile 的迁移、幂等、回滚和读回；显式常量让每条断言的工具面一目了然。 */
const BOTH = ["core", "memory"] as const;

describe("Agent MCP 配置适配", () => {
  it("Codex 原子迁移旧单入口为双 Profile，并保持幂等", () => {
    const root = mkdtempSync(join(tmpdir(), "atm-codex-dual-config-"));
    temporary.push(root);
    const path = join(root, "config.toml");
    writeFileSync(
      path,
      [
        'model = "gpt"',
        "",
        "[mcp_servers.other]",
        'command = "other.exe"',
        "",
        '[mcp_servers."ayanami-task-manager"]',
        'command = "old.exe"',
        'args = ["old-bridge.cjs"]',
        "",
      ].join("\n"),
      "utf8",
    );
    expect(isCodexConfigInstalled(path)).toBe(false);

    installCodexConfig({ path, command: "atm.exe", args: ["bridge.cjs"], profiles: BOTH });
    expect(isCodexConfigInstalled(path, BOTH)).toBe(true);
    const migrated = readFileSync(path, "utf8");
    expect(migrated).toContain("[mcp_servers.other]");
    expect(migrated).not.toContain('[mcp_servers."ayanami-task-manager"]');
    expect(migrated).toContain('[mcp_servers."ayanami-task-manager-core"]');
    expect(migrated).toContain('args = ["bridge.cjs", "--profile", "core"]');
    expect(migrated).toContain('[mcp_servers."ayanami-task-manager-memory"]');
    expect(migrated).toContain('args = ["bridge.cjs", "--profile", "memory"]');

    const repeated = installCodexConfig({
      path,
      command: "atm.exe",
      args: ["bridge.cjs"],
      profiles: BOTH,
    });
    expect(repeated.backupPath).toBeNull();
    expect(readFileSync(path, "utf8")).toBe(migrated);

    uninstallCodexConfig(path);
    const removed = readFileSync(path, "utf8");
    expect(removed).toContain("[mcp_servers.other]");
    expect(removed).not.toContain("ayanami-task-manager");
  });

  it("Codex 只合并自己的 TOML 段并备份旧文件", () => {
    const root = mkdtempSync(join(tmpdir(), "atm-codex-config-"));
    temporary.push(root);
    const path = join(root, "config.toml");
    writeFileSync(path, 'model = "gpt"\n\n[mcp_servers.other]\ncommand = "other.exe"\n', "utf8");
    const result = installCodexConfig({
      path,
      command: "C:\\Program Files\\ATM\\AyanamiTaskManager.exe",
      profiles: BOTH,
    });
    const content = readFileSync(path, "utf8");
    expect(existsSync(result.backupPath!)).toBe(true);
    expect(content).toContain("[mcp_servers.other]");
    expect(content).toContain('[mcp_servers."ayanami-task-manager-core"]');
    expect(content).toContain('args = ["--mcp-stdio", "--profile", "core"]');
    expect(content).toContain('[mcp_servers."ayanami-task-manager-memory"]');
    installCodexConfig({ path, command: "C:\\ATM\\new.exe", profiles: BOTH });
    expect(
      readFileSync(path, "utf8").match(/\[mcp_servers\."ayanami-task-manager-(?:core|memory)"\]/gu),
    ).toHaveLength(2);
    uninstallCodexConfig(path);
    expect(readFileSync(path, "utf8")).toContain("[mcp_servers.other]");
    expect(readFileSync(path, "utf8")).not.toContain("ayanami-task-manager");
  });

  it("Claude Desktop 原子迁移旧单入口并保留其他 JSON", () => {
    const root = mkdtempSync(join(tmpdir(), "atm-claude-dual-config-"));
    temporary.push(root);
    const path = join(root, "claude_desktop_config.json");
    writeFileSync(
      path,
      JSON.stringify({
        theme: "dark",
        mcpServers: {
          other: { command: "other" },
          "ayanami-task-manager": { command: "old.exe", args: ["old.cjs"] },
        },
      }),
      "utf8",
    );
    expect(isClaudeConfigInstalled(path)).toBe(false);

    installClaudeConfig({ path, command: "atm.exe", args: ["bridge.cjs"], profiles: BOTH });
    expect(isClaudeConfigInstalled(path, BOTH)).toBe(true);
    const migratedText = readFileSync(path, "utf8");
    const migrated = JSON.parse(migratedText);
    expect(migrated.theme).toBe("dark");
    expect(migrated.mcpServers.other).toEqual({ command: "other" });
    expect(migrated.mcpServers["ayanami-task-manager"]).toBeUndefined();
    expect(migrated.mcpServers["ayanami-task-manager-core"]).toEqual({
      command: "atm.exe",
      args: ["bridge.cjs", "--profile", "core"],
    });
    expect(migrated.mcpServers["ayanami-task-manager-memory"]).toEqual({
      command: "atm.exe",
      args: ["bridge.cjs", "--profile", "memory"],
    });

    const repeated = installClaudeConfig({
      path,
      command: "atm.exe",
      args: ["bridge.cjs"],
      profiles: BOTH,
    });
    expect(repeated.backupPath).toBeNull();
    expect(readFileSync(path, "utf8")).toBe(migratedText);

    uninstallClaudeConfig(path);
    const removed = JSON.parse(readFileSync(path, "utf8"));
    expect(removed.theme).toBe("dark");
    expect(removed.mcpServers).toEqual({ other: { command: "other" } });
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
    const result = installClaudeConfig({
      path,
      command: "C:\\ATM\\AyanamiTaskManager.exe",
      profiles: BOTH,
    });
    const content = JSON.parse(readFileSync(path, "utf8"));
    expect(existsSync(result.backupPath!)).toBe(true);
    expect(content.theme).toBe("dark");
    expect(content.mcpServers.other).toEqual({ command: "other" });
    expect(content.mcpServers["ayanami-task-manager-core"]).toEqual({
      command: "C:\\ATM\\AyanamiTaskManager.exe",
      args: ["--mcp-stdio", "--profile", "core"],
    });
    expect(content.mcpServers["ayanami-task-manager-memory"]).toEqual({
      command: "C:\\ATM\\AyanamiTaskManager.exe",
      args: ["--mcp-stdio", "--profile", "memory"],
    });
    uninstallClaudeConfig(path);
    const removed = JSON.parse(readFileSync(path, "utf8"));
    expect(removed.theme).toBe("dark");
    expect(removed.mcpServers.other).toEqual({ command: "other" });
    expect(removed.mcpServers["ayanami-task-manager-core"]).toBeUndefined();
    expect(removed.mcpServers["ayanami-task-manager-memory"]).toBeUndefined();
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
      profiles: BOTH,
    });

    expect(result.client).toBe("CLAUDE_CODE");
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.cli).toBe("C:\\fake\\claude.exe");
    expect(calls.map((call) => call.args.slice(0, 3))).toEqual([
      ["mcp", "add-json", "ayanami-task-manager-core"],
      ["mcp", "add-json", "ayanami-task-manager-memory"],
    ]);
    expect(calls.every((call) => call.args.slice(-2).join(" ") === "--scope user")).toBe(true);
    const payloads = calls.map((call) => JSON.parse(call.args[3]!));
    // stdio 传输：不能把每次重启都会变的 endpoint / token 写死进配置。
    expect(payloads[0]).toEqual({
      command: "C:\\ATM\\AyanamiTaskManager.exe",
      args: ["C:\\ATM\\resources\\mcp-stdio.cjs", "--profile", "core"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(payloads[1].args.slice(-2)).toEqual(["--profile", "memory"]);
    expect(JSON.stringify(payloads)).not.toContain("Bearer");
    expect(JSON.stringify(payloads)).not.toContain("127.0.0.1");

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
      profiles: BOTH,
    });
    expect(calls.map((call) => call.args[1])).toEqual(["remove", "add-json", "add-json"]);

    // 新配置注册失败时，必须仍通过 CLI 恢复旧 server，不能把现有接入删掉。
    calls.length = 0;
    expect(() =>
      installClaudeCodeConfig({
        command: "C:\\ATM\\broken.exe",
        cliPath: "C:\\fake\\claude.exe",
        configPath: path,
        profiles: BOTH,
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

  it("Claude Code 双入口安装幂等，任一失败时经 CLI 回滚旧配置", () => {
    const root = mkdtempSync(join(tmpdir(), "atm-claude-code-dual-"));
    temporary.push(root);
    const path = join(root, ".claude.json");
    let state: Record<string, unknown> = {
      projects: { demo: { history: ["keep"] } },
      mcpServers: {
        other: { command: "other" },
        "ayanami-task-manager": { command: "old.exe", args: ["old.cjs"] },
      },
    };
    const persist = () => writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    persist();
    const calls: string[][] = [];
    let rejectMemory = false;
    const runCli = (_cli: string, args: string[]) => {
      calls.push(args);
      const servers = { ...((state.mcpServers ?? {}) as Record<string, unknown>) };
      if (args[1] === "remove") {
        delete servers[args[2]!];
      } else if (args[1] === "add-json") {
        if (rejectMemory && args[2] === "ayanami-task-manager-memory") {
          throw new Error("memory registration failed");
        }
        servers[args[2]!] = JSON.parse(args[3]!);
      }
      state = { ...state, mcpServers: servers };
      persist();
    };

    installClaudeCodeConfig({
      command: "atm.exe",
      args: ["bridge.cjs"],
      cliPath: "claude.exe",
      configPath: path,
      runCli,
      profiles: BOTH,
    });
    expect(isClaudeCodeConfigInstalled(path, BOTH)).toBe(true);
    expect(calls.map((args) => args.slice(1, 3))).toEqual([
      ["remove", "ayanami-task-manager"],
      ["add-json", "ayanami-task-manager-core"],
      ["add-json", "ayanami-task-manager-memory"],
    ]);
    expect(state.projects).toEqual({ demo: { history: ["keep"] } });
    expect((state.mcpServers as Record<string, unknown>).other).toEqual({ command: "other" });

    calls.length = 0;
    installClaudeCodeConfig({
      command: "atm.exe",
      args: ["bridge.cjs"],
      cliPath: "claude.exe",
      configPath: path,
      runCli,
      profiles: BOTH,
    });
    expect(calls).toEqual([]);

    uninstallClaudeCodeConfig({ cliPath: "claude.exe", configPath: path, runCli });
    expect(calls.map((args) => args.slice(1, 3))).toEqual([
      ["remove", "ayanami-task-manager-core"],
      ["remove", "ayanami-task-manager-memory"],
    ]);
    expect(state.mcpServers).toEqual({ other: { command: "other" } });
    calls.length = 0;
    installClaudeCodeConfig({
      command: "atm.exe",
      args: ["bridge.cjs"],
      cliPath: "claude.exe",
      configPath: path,
      runCli,
      profiles: BOTH,
    });
    expect(calls.map((args) => args.slice(1, 3))).toEqual([
      ["add-json", "ayanami-task-manager-core"],
      ["add-json", "ayanami-task-manager-memory"],
    ]);

    state = {
      ...state,
      mcpServers: {
        other: { command: "other" },
        "ayanami-task-manager": { command: "old.exe", args: ["old.cjs"] },
      },
    };
    persist();
    calls.length = 0;
    rejectMemory = true;
    expect(() =>
      installClaudeCodeConfig({
        command: "atm.exe",
        args: ["bridge.cjs"],
        cliPath: "claude.exe",
        configPath: path,
        runCli,
        profiles: BOTH,
      }),
    ).toThrow("memory registration failed");
    expect(state.mcpServers).toEqual({
      other: { command: "other" },
      "ayanami-task-manager": { command: "old.exe", args: ["old.cjs"] },
    });
    expect(isClaudeCodeConfigInstalled(path)).toBe(false);
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

  it("生成双 Profile 的 Streamable HTTP、stdio 和通用 JSON 配置", () => {
    const rendered = renderMcpConfigs(
      {
        endpoint: "http://127.0.0.1:43210",
        token: "secret",
        command: "atm.exe",
        env: { ELECTRON_RUN_AS_NODE: "1" },
      },
      BOTH,
    );
    const http = JSON.parse(rendered.streamableHttp).mcpServers;
    const stdio = JSON.parse(rendered.stdio).mcpServers;
    const generic = JSON.parse(rendered.generic).mcpServers;
    expect(Object.keys(http).sort()).toEqual([
      "ayanami-task-manager-core",
      "ayanami-task-manager-memory",
    ]);
    expect(http["ayanami-task-manager-core"].url).toBe("http://127.0.0.1:43210/mcp/core");
    expect(http["ayanami-task-manager-memory"].url).toBe("http://127.0.0.1:43210/mcp/memory");
    expect(rendered.streamableHttp).toContain("Bearer secret");
    expect(stdio["ayanami-task-manager-core"].args).toEqual(["--mcp-stdio", "--profile", "core"]);
    expect(stdio["ayanami-task-manager-memory"].args).toEqual([
      "--mcp-stdio",
      "--profile",
      "memory",
    ]);
    expect(rendered.stdio).toContain("ELECTRON_RUN_AS_NODE");
    expect(generic).toEqual(stdio);
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

// 判断「装没装」不够用：配置可以装着、却指向一个已经不存在的路径。要修就得先能
// 读出登记的到底是什么，而且读回来的必须和写进去的逐字相同——否则每次启动都会
// 判成「过期」，无休止地重写用户的配置文件。
describe("读回已登记的 MCP 启动方式", () => {
  const launch = {
    command: "C:\\Users\\x\\AppData\\Local\\AyanamiTaskManagerDesktop\\AyanamiTaskManager.exe",
    args: ["C:\\Users\\x\\AppData\\Local\\AyanamiTaskManager\\mcp-stdio.cjs"],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };

  it("Codex：写进去什么就读回什么，别人的段不影响", () => {
    const root = mkdtempSync(join(tmpdir(), "atm-read-codex-"));
    temporary.push(root);
    const path = join(root, "config.toml");
    writeFileSync(
      path,
      'model = "gpt"\n\n[mcp_servers.other]\ncommand = "other.exe"\nargs = ["x"]\n',
      "utf8",
    );
    expect(installedCodexLaunch(path)).toBeNull();

    installCodexConfig({ path, ...launch, profiles: BOTH });
    expect(installedCodexProfileLaunches(path)).toEqual({
      legacy: null,
      core: {
        command: launch.command,
        args: [...launch.args, "--profile", "core"],
        env: launch.env,
      },
      memory: {
        command: launch.command,
        args: [...launch.args, "--profile", "memory"],
        env: launch.env,
      },
      actions: null,
    });
  });

  it("Claude Desktop：写进去什么就读回什么", () => {
    const root = mkdtempSync(join(tmpdir(), "atm-read-claude-"));
    temporary.push(root);
    const path = join(root, "claude_desktop_config.json");
    expect(installedClaudeLaunch(path)).toBeNull();

    installClaudeConfig({ path, ...launch, profiles: BOTH });
    expect(installedClaudeProfileLaunches(path)).toEqual({
      legacy: null,
      core: {
        command: launch.command,
        args: [...launch.args, "--profile", "core"],
        env: launch.env,
      },
      memory: {
        command: launch.command,
        args: [...launch.args, "--profile", "memory"],
        env: launch.env,
      },
      actions: null,
    });
  });

  it("Claude Code：写进去什么就读回什么", () => {
    const root = mkdtempSync(join(tmpdir(), "atm-read-claude-code-"));
    temporary.push(root);
    const path = join(root, ".claude.json");
    expect(installedClaudeCodeLaunch(path)).toBeNull();

    installClaudeCodeConfig({
      configPath: path,
      ...launch,
      profiles: BOTH,
      cliPath: "claude",
      runCli: (_cli, args) => {
        const name = args[args.indexOf("add-json") + 1] as string;
        const payload = JSON.parse(args[args.indexOf("add-json") + 2] as string) as Record<
          string,
          unknown
        >;
        const existing = existsSync(path)
          ? (JSON.parse(readFileSync(path, "utf8")) as {
              mcpServers?: Record<string, unknown>;
            })
          : {};
        writeFileSync(
          path,
          `${JSON.stringify({ ...existing, mcpServers: { ...existing.mcpServers, [name]: payload } }, null, 2)}\n`,
          "utf8",
        );
      },
    });
    expect(installedClaudeCodeProfileLaunches(path)).toEqual({
      legacy: null,
      core: {
        command: launch.command,
        args: [...launch.args, "--profile", "core"],
        env: launch.env,
      },
      memory: {
        command: launch.command,
        args: [...launch.args, "--profile", "memory"],
        env: launch.env,
      },
      actions: null,
    });
  });

  // 坏文件不能让启动挂掉，也不能被当成「已登记但不一致」而触发重写。
  it("文件损坏或没有这一项时返回 null", () => {
    const root = mkdtempSync(join(tmpdir(), "atm-read-broken-"));
    temporary.push(root);
    const broken = join(root, "broken.json");
    writeFileSync(broken, "{ not json", "utf8");
    expect(installedClaudeLaunch(broken)).toBeNull();
    expect(installedClaudeCodeLaunch(broken)).toBeNull();
    expect(installedCodexLaunch(join(root, "missing.toml"))).toBeNull();
  });
});

// 备份原本只在用户手动点安装时产生，攒得慢。改成每次启动核对、版本变了就重写之后，
// 每发一版给三个客户端各留一份，一年就是几百个文件躺在 ~/.codex 和 %APPDATA%\Claude 里。
describe("配置备份保留上限", () => {
  it("只保留最近几份，且只删自己的备份", () => {
    const root = mkdtempSync(join(tmpdir(), "atm-backup-retention-"));
    temporary.push(root);
    const path = join(root, "claude_desktop_config.json");
    // 别人的文件和别人的备份都不能被碰到。
    const foreign = join(root, "other.json");
    const foreignBackup = join(root, "other.json.bak-2020-01-01T00-00-00-000Z-aaaaaa");
    writeFileSync(foreign, "{}", "utf8");
    writeFileSync(foreignBackup, "{}", "utf8");

    // 写 BACKUP_RETENTION + 3 次，每次都会先备份上一版。
    const marker = (index: number) => `ATM_BACKUP_MARKER_${String(index)}`;
    for (let i = 0; i < BACKUP_RETENTION + 3; i += 1) {
      installClaudeConfig({ path, command: marker(i) });
    }
    const backups = readdirSync(root).filter((name) =>
      name.startsWith("claude_desktop_config.json.bak-"),
    );
    expect(backups).toHaveLength(BACKUP_RETENTION);
    // 留下的必须是最新那几份：最早那次写的 v0 不该还在。
    const contents = backups.map((name) => readFileSync(join(root, name), "utf8"));
    expect(contents.some((text) => text.includes(marker(0)))).toBe(false);
    expect(contents.some((text) => text.includes(marker(BACKUP_RETENTION + 1)))).toBe(true);

    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(foreignBackup)).toBe(true);
  });
});

import { join } from "node:path";
import { clipboard, ipcMain } from "electron";
import {
  claudeDesktopConfigPaths,
  defaultClaudeRulePath,
  defaultClaudeSkillsPath,
  defaultCodexRulePath,
  defaultCodexSkillsPath,
  findClaudeCodeCli,
  inspectAgentSkills,
  inspectManagedAgentRule,
  installClaudeCodeConfig,
  installClaudeConfig,
  installCodexConfig,
  installedClaudeCodeProfileLaunches,
  installedClaudeProfileLaunches,
  installedClaudeProfileLaunchSets,
  installedCodexProfileLaunches,
  installAgentSkills,
  isClaudeCodeConfigInstalled,
  isClaudeConfigInstalled,
  isCodexConfigInstalled,
  manageAgentRule,
  renderMcpConfigs,
  uninstallAgentSkills,
  uninstallClaudeCodeConfig,
  uninstallClaudeConfig,
  uninstallCodexConfig,
  type AgentRuleAction,
  type McpClient,
  type McpProfile,
} from "@ayanami-task/agent-config";
import type { AyanamiTaskService } from "@ayanami-task/application";
import {
  mcpLaunch,
  mcpProfileLaunches,
  mcpProfileLaunchesStale,
  shouldRepairMcpConfigs,
  type McpLaunch,
  type McpProfileLaunches,
} from "./mcp-launch.js";
import { observeMcpBridges } from "./mcp-bridge-observation.js";
import {
  hasManagedMcpProfile,
  memoryProfileEnabledValue,
  profilesRepresentedBy,
  runMcpProfileSwitch,
  type McpProfileSyncAdapter,
} from "./mcp-profile-switch.js";
import type { Runtime } from "./runtime-host.js";

export type AgentIntegrationHostOptions = {
  service: AyanamiTaskService;
  runtime: Runtime;
  dataDir: string;
  execPath: string;
  packaged: boolean;
  smokeTrace(stage: string, detail?: unknown): void;
};

export function installAgentIntegrationHost(options: AgentIntegrationHostOptions): void {
  const service = options.service;
  const runtime = options.runtime;
  const dataDirBeforeReady = () => options.dataDir;
  const smokeTrace = options.smokeTrace;
  /** memory + actions 的低内存降级开关；未设置时默认开启完整工具面。 */
  const MEMORY_PROFILE_SETTING = "mcp.memory-profile-enabled";
  const mcpRepairFailures = new Map<McpClient, string>();

  function memoryProfileEnabled(): boolean {
    // 设置缺失或暂时读失败都保持完整能力；只有用户明确写入 false 才降级。
    try {
      return memoryProfileEnabledValue(
        service?.getSetting<boolean>(MEMORY_PROFILE_SETTING, true).value,
      );
    } catch {
      return true;
    }
  }

  function enabledProfiles(): McpProfile[] {
    return memoryProfileEnabled() ? ["core", "memory", "actions"] : ["core"];
  }

  function profileSyncAdapters(write: {
    command: string;
    args: string[];
    env: Record<string, string>;
  }): McpProfileSyncAdapter[] {
    const codex = installedCodexProfileLaunches();
    const claudeCode = installedClaudeCodeProfileLaunches();
    return [
      {
        client: "CODEX",
        target: "Codex",
        present: hasManagedMcpProfile(codex),
        previousProfiles: profilesRepresentedBy(codex),
        apply: (profiles) => void installCodexConfig({ ...write, profiles }),
      },
      ...claudeDesktopConfigPaths().map((path) => {
        const launches = installedClaudeProfileLaunches(path);
        return {
          client: "CLAUDE" as const,
          target: `Claude Desktop (${path})`,
          present: hasManagedMcpProfile(launches),
          previousProfiles: profilesRepresentedBy(launches),
          apply: (profiles: readonly McpProfile[]) =>
            void installClaudeConfig({ ...write, path, profiles }),
        } satisfies McpProfileSyncAdapter;
      }),
      {
        client: "CLAUDE_CODE",
        target: "Claude Code",
        present: hasManagedMcpProfile(claudeCode),
        previousProfiles: profilesRepresentedBy(claudeCode),
        apply: (profiles) => void installClaudeCodeConfig({ ...write, profiles }),
      },
    ];
  }

  /**
   * 旧配置里的路径钉着 app-<version>，自更新之后就指向一个不存在的文件。光把新配置
   * 写对不够：机器上那份旧的没人会去改——`isInstalled` 一直为真，界面一直显示「已安装」，
   * 用户没有任何理由再点一次安装，只会看到 Agent 连不上而找不到原因。
   *
   * 所以每次启动核对一次，只动 ATM 的受管 server。任何一个客户端出错都不能影响启动：
   * 写入诊断 trace，继续下一个；用户主动切换则走上面的事务化同步，不能吞错。
   */
  function repairStaleMcpConfigs(launch: McpLaunch, profiles: McpProfileLaunches): void {
    const write = { command: launch.command, args: launch.args, env: launch.env };
    const enabled = enabledProfiles();
    const clients: Array<{ client: McpClient; stale: () => boolean; repair: () => void }> = [
      {
        client: "CODEX",
        stale: () => mcpProfileLaunchesStale(installedCodexProfileLaunches(), profiles, enabled),
        repair: () => void installCodexConfig({ ...write, profiles: enabled }),
      },
      {
        // Claude 桌面版有两份配置（Store 装的那份被重定向进包容器），任何一份过期都要修：
        // 修了 A 没修 B，就是应用读 B 的那台机器一直坏着，而我们这边看着是绿的。
        client: "CLAUDE",
        stale: () =>
          installedClaudeProfileLaunchSets().some((each) =>
            mcpProfileLaunchesStale(each, profiles, enabled),
          ),
        repair: () => void installClaudeConfig({ ...write, profiles: enabled }),
      },
      {
        // Claude Code 的 user scope 只能由 claude CLI 代写；找不到 CLI 时无从修起，
        // 每次启动抛一次异常也没有意义。
        client: "CLAUDE_CODE",
        stale: () =>
          findClaudeCodeCli() !== null &&
          mcpProfileLaunchesStale(installedClaudeCodeProfileLaunches(), profiles, enabled),
        repair: () => void installClaudeCodeConfig({ ...write, profiles: enabled }),
      },
    ];
    for (const entry of clients) {
      try {
        if (!entry.stale()) continue;
        entry.repair();
        mcpRepairFailures.delete(entry.client);
        smokeTrace("mcp.config-repaired", entry.client);
      } catch (error) {
        mcpRepairFailures.set(entry.client, error instanceof Error ? error.message : String(error));
        smokeTrace("mcp.config-repair-failed", {
          client: entry.client,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // Claude Code 与 Claude Desktop 共用 ~/.claude/CLAUDE.md 与 ~/.claude/skills，
  // 只有 MCP 注册位置不同：Desktop 读 claude_desktop_config.json，Claude Code 读 ~/.claude.json。
  function agentIntegrationPaths(client: McpClient) {
    return client === "CODEX"
      ? { rulePath: defaultCodexRulePath(), skillsPath: defaultCodexSkillsPath() }
      : { rulePath: defaultClaudeRulePath(), skillsPath: defaultClaudeSkillsPath() };
  }

  function mcpInstalledFor(client: McpClient): boolean {
    const profiles = enabledProfiles();
    if (client === "CODEX") return isCodexConfigInstalled(undefined, profiles);
    if (client === "CLAUDE") return isClaudeConfigInstalled(undefined, profiles);
    return isClaudeCodeConfigInstalled(undefined, profiles);
  }

  /**
   * 「还留着任意一个 ATM 的 MCP server」——判据比 mcpInstalledFor 宽，故意的。
   *
   * 卸载共用的规则与技能之前要问的是「另一个客户端是否还在用 ATM」，不是「它是否配得
   * 完全正确」。用严格判据的话，兄弟客户端只要有一项待修（例如刚打开 memory 还没写下去），
   * 就会被判成没装，于是把它还在用的规则和技能一起删掉。
   */
  function mcpPresentFor(client: McpClient): boolean {
    if (client === "CODEX") return hasManagedMcpProfile(installedCodexProfileLaunches());
    if (client === "CLAUDE") return installedClaudeProfileLaunchSets().some(hasManagedMcpProfile);
    return hasManagedMcpProfile(installedClaudeCodeProfileLaunches());
  }

  function agentIntegrationReport(client: McpClient) {
    const paths = agentIntegrationPaths(client);
    return {
      client,
      mcpInstalled: mcpInstalledFor(client),
      repairError: mcpRepairFailures.get(client) ?? null,
      // 规则与技能和哪个客户端同源；UI 合并显示时据此避免重复计数。
      sharesRuleAndSkillsWith: client === "CLAUDE_CODE" ? ("CLAUDE" as const) : null,
      // Claude Code 的 user scope 必须由 claude CLI 代写，找不到时安装按钮应不可用。
      cliAvailable: client === "CLAUDE_CODE" ? findClaudeCodeCli() !== null : true,
      rule: inspectManagedAgentRule(paths.rulePath),
      skills: inspectAgentSkills({
        sourceRoot: join(dataDirBeforeReady(), "skills"),
        targetRoot: paths.skillsPath,
      }),
    };
  }
  const launch = mcpLaunch({ execPath: options.execPath, dataDir: dataDirBeforeReady() });
  const profileLaunches = mcpProfileLaunches({
    execPath: options.execPath,
    dataDir: dataDirBeforeReady(),
  });
  const stdioCommand = launch.command;
  const stdioArgs = launch.args;
  const stdioEnv = launch.env;
  if (shouldRepairMcpConfigs(process.env, options.packaged))
    repairStaleMcpConfigs(launch, profileLaunches);
  ipcMain.handle("atm:get-mcp-bridges", () => observeMcpBridges({ bridgeCommand: stdioCommand }));
  ipcMain.handle("atm:get-mcp-configs", () => {
    if (!runtime) throw new Error("RUNTIME_NOT_READY");
    return renderMcpConfigs(
      { ...runtime, command: stdioCommand, args: stdioArgs, env: stdioEnv },
      enabledProfiles(),
    );
  });
  ipcMain.handle("atm:get-memory-profile", () => memoryProfileEnabled());
  ipcMain.handle("atm:set-memory-profile", (_event, enabled: boolean) => {
    if (!service) throw new Error("RUNTIME_NOT_READY");
    const current = service.getSetting<boolean>(MEMORY_PROFILE_SETTING, true);
    const write = { command: stdioCommand, args: stdioArgs, env: stdioEnv };
    const result = runMcpProfileSwitch({
      enabled: enabled === true,
      // ATM_DATA_DIR 是烟测/隔离环境，绝不能借设置开关改用户全局 Agent 配置。
      adapters: shouldRepairMcpConfigs(process.env, options.packaged)
        ? profileSyncAdapters(write)
        : [],
      // 客户端全部同步成功后才提交偏好；失败由 runMcpProfileSwitch 逆序回滚。
      commit: () => {
        service!.setSetting(
          MEMORY_PROFILE_SETTING,
          enabled === true,
          current.version < 0 ? undefined : current.version,
        );
      },
    });
    for (const entry of result.clients) {
      if (entry.status === "UPDATED") mcpRepairFailures.delete(entry.client);
    }
    return result;
  });
  ipcMain.handle("atm:install-mcp", (_event, client: McpClient) => {
    const write = {
      command: stdioCommand,
      args: stdioArgs,
      env: stdioEnv,
      profiles: enabledProfiles(),
    };
    const result =
      client === "CODEX"
        ? installCodexConfig(write)
        : client === "CLAUDE"
          ? installClaudeConfig(write)
          : client === "CLAUDE_CODE"
            ? installClaudeCodeConfig(write)
            : null;
    if (!result) throw new Error("MCP_CLIENT_UNSUPPORTED");
    mcpRepairFailures.delete(client);
    return result;
  });
  ipcMain.handle("atm:get-agent-integrations", () => [
    agentIntegrationReport("CODEX"),
    agentIntegrationReport("CLAUDE"),
    agentIntegrationReport("CLAUDE_CODE"),
  ]);
  ipcMain.handle(
    "atm:manage-agent-integration",
    (_event, client: McpClient, action: AgentRuleAction) => {
      if (!(client === "CODEX" || client === "CLAUDE" || client === "CLAUDE_CODE"))
        throw new Error("MCP_CLIENT_UNSUPPORTED");
      const paths = agentIntegrationPaths(client);
      const skillState = inspectAgentSkills({
        sourceRoot: join(dataDirBeforeReady(), "skills"),
        targetRoot: paths.skillsPath,
      }).state;
      if (
        action !== "PREVIEW" &&
        action !== "UNINSTALL" &&
        skillState === "MODIFIED" &&
        action !== "REPAIR"
      ) {
        throw new Error("AGENT_SKILL_MODIFIED_REQUIRES_REPAIR");
      }
      // CLAUDE 与 CLAUDE_CODE 共用规则与技能路径。卸载其中一个时，只要另一个还装着
      // MCP，就必须保留共用的规则和技能，否则会连带废掉仍在使用的那一个。
      const sibling: McpClient | null =
        client === "CLAUDE" ? "CLAUDE_CODE" : client === "CLAUDE_CODE" ? "CLAUDE" : null;
      const siblingStillInstalled = sibling !== null && mcpPresentFor(sibling);
      const removeSharedAssets = action === "UNINSTALL" && !siblingStillInstalled;
      const rule = manageAgentRule({
        path: paths.rulePath,
        action: action === "UNINSTALL" && !removeSharedAssets ? "PREVIEW" : action,
      });
      if (action === "PREVIEW") return { report: agentIntegrationReport(client), preview: rule };
      if (action === "UNINSTALL") {
        if (client === "CODEX") uninstallCodexConfig();
        else if (client === "CLAUDE") uninstallClaudeConfig();
        else uninstallClaudeCodeConfig();
        if (removeSharedAssets) uninstallAgentSkills(paths.skillsPath);
      } else {
        const profiles = enabledProfiles();
        const write = { command: stdioCommand, args: stdioArgs, env: stdioEnv, profiles };
        if (client === "CODEX" && !isCodexConfigInstalled(undefined, profiles))
          installCodexConfig(write);
        if (client === "CLAUDE" && !isClaudeConfigInstalled(undefined, profiles))
          installClaudeConfig(write);
        if (client === "CLAUDE_CODE" && !isClaudeCodeConfigInstalled(undefined, profiles))
          installClaudeCodeConfig(write);
        if (skillState !== "INSTALLED")
          installAgentSkills({
            sourceRoot: join(dataDirBeforeReady(), "skills"),
            targetRoot: paths.skillsPath,
          });
      }
      mcpRepairFailures.delete(client);
      return { report: agentIntegrationReport(client), preview: null };
    },
  );
  ipcMain.handle("atm:copy-text", (_event, text: string) => {
    clipboard.writeText(text);
    return true;
  });
}

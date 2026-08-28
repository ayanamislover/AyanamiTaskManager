/**
 * Public facade for agent integration.
 *
 * Domain behavior lives in rules, skills, MCP installation, and MCP inspection
 * modules. Keep this surface stable for the desktop app and external clients.
 */
export {
  ATM_INTEGRATION_VERSION,
  ATM_SKILL_NAMES,
  DEFAULT_MCP_PROFILES,
  MCP_SERVER_NAMES,
  enabledMcpProfiles,
} from "./contracts.js";
export type {
  AgentIntegrationState,
  AgentRuleAction,
  ClaudeCodeCliRunner,
  InstallResult,
  InstalledMcpLaunch,
  InstalledMcpProfileLaunches,
  McpClient,
  McpProfile,
  McpRuntime,
} from "./contracts.js";

export { BACKUP_RETENTION } from "./atomic-files.js";
export {
  AGENT_RULE_SNIPPET,
  inspectManagedAgentRule,
  manageAgentRule,
  renderManagedAgentRule,
} from "./agent-rules.js";
export { installAgentSkills, inspectAgentSkills, uninstallAgentSkills } from "./agent-skills.js";
export {
  claudeDesktopConfigPaths,
  defaultClaudeCodeConfigPath,
  defaultClaudeConfigPath,
  defaultClaudeRulePath,
  defaultClaudeSkillsPath,
  defaultCodexConfigPath,
  defaultCodexRulePath,
  defaultCodexSkillsPath,
  findClaudeCodeCli,
} from "./mcp-paths.js";
export {
  installClaudeCodeConfig,
  installClaudeConfig,
  installCodexConfig,
  renderMcpConfigs,
  uninstallClaudeCodeConfig,
  uninstallClaudeConfig,
  uninstallCodexConfig,
} from "./mcp-install.js";
export {
  installedClaudeCodeLaunch,
  installedClaudeCodeProfileLaunches,
  installedClaudeLaunch,
  installedClaudeLaunches,
  installedClaudeProfileLaunches,
  installedClaudeProfileLaunchSets,
  installedCodexLaunch,
  installedCodexProfileLaunches,
  isClaudeCodeConfigInstalled,
  isClaudeConfigInstalled,
  isCodexConfigInstalled,
} from "./mcp-inspection.js";

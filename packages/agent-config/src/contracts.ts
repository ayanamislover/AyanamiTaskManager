/** Public data contracts shared by the agent integration modules. */
export type McpRuntime = {
  endpoint: string;
  token: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type McpClient = "CODEX" | "CLAUDE" | "CLAUDE_CODE";
export type InstallResult = { client: McpClient; path: string; backupPath: string | null };
export type McpProfile = "core" | "memory" | "actions";

export const MCP_SERVER_NAMES = {
  legacy: "ayanami-task-manager",
  core: "ayanami-task-manager-core",
  memory: "ayanami-task-manager-memory",
  actions: "ayanami-task-manager-actions",
} as const;

export const ATM_SKILL_NAMES = ["atm-plan", "atm-task"] as const;
export const ATM_SKILL_RESOURCE_DIRECTORIES = ["_shared"] as const;
export const ATM_INTEGRATION_VERSION = 1;

export type AgentIntegrationState = "NOT_INSTALLED" | "INSTALLED" | "NEEDS_UPDATE" | "MODIFIED";
export type AgentRuleAction = "PREVIEW" | "INSTALL" | "UPDATE" | "REPAIR" | "UNINSTALL";

export type McpInstallInput = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type InstalledMcpLaunch = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

export type InstalledMcpProfileLaunches = {
  legacy: InstalledMcpLaunch | null;
  core: InstalledMcpLaunch | null;
  memory: InstalledMcpLaunch | null;
  actions: InstalledMcpLaunch | null;
};

export type ClaudeCodeCliRunner = (cli: string, args: string[]) => void;

/** 默认提供完整工具面；调用方可显式传 ["core"] 进入低内存降级模式。 */
export const DEFAULT_MCP_PROFILES: readonly McpProfile[] = ["core", "memory", "actions"];
export const ALL_MCP_PROFILES: readonly McpProfile[] = ["core", "memory", "actions"];

export const MANAGED_MCP_SERVER_NAMES: readonly string[] = Object.values(MCP_SERVER_NAMES);

export function isManagedMcpServerName(name: string): boolean {
  return MANAGED_MCP_SERVER_NAMES.some((managed) => managed === name);
}

/** 将用户选择归一为稳定顺序；core 是任何受管 ATM 配置的最小入口。 */
export function enabledMcpProfiles(profiles?: readonly McpProfile[]): McpProfile[] {
  const requested = new Set<McpProfile>(profiles ?? DEFAULT_MCP_PROFILES);
  requested.add("core");
  return ALL_MCP_PROFILES.filter((profile) => requested.has(profile));
}

export function profileArgs(args: string[] | undefined, profile: McpProfile): string[] {
  const source = [...(args ?? ["--mcp-stdio"])];
  const marker = source.indexOf("--profile");
  if (marker >= 0) source.splice(marker, Math.min(2, source.length - marker));
  return [...source, "--profile", profile];
}

export function profileLaunch(input: McpInstallInput, profile: McpProfile): McpInstallInput {
  return {
    command: input.command,
    args: profileArgs(input.args, profile),
    ...(input.env ? { env: input.env } : {}),
  };
}

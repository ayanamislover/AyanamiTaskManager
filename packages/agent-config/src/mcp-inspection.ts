import { existsSync, readFileSync } from "node:fs";
import {
  enabledMcpProfiles,
  isManagedMcpServerName,
  MCP_SERVER_NAMES,
  type InstalledMcpLaunch,
  type InstalledMcpProfileLaunches,
  type McpInstallInput,
  type McpProfile,
} from "./contracts.js";
import {
  claudeDesktopConfigPaths,
  defaultClaudeCodeConfigPath,
  defaultClaudeConfigPath,
  defaultCodexConfigPath,
} from "./mcp-paths.js";

function emptyLaunches(): InstalledMcpProfileLaunches {
  return { legacy: null, core: null, memory: null, actions: null };
}

export function stringRecord(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.every((entry): entry is [string, string] => typeof entry[1] === "string")
    ? Object.fromEntries(entries)
    : null;
}

export function readJsonMcpServers(path: string): Record<string, Record<string, unknown>> | null {
  if (!existsSync(path)) return null;
  try {
    const content = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (!content.mcpServers || typeof content.mcpServers !== "object") return {};
    return Object.fromEntries(
      Object.entries(content.mcpServers as Record<string, unknown>).filter(
        (entry): entry is [string, Record<string, unknown>] =>
          Boolean(entry[1] && typeof entry[1] === "object" && !Array.isArray(entry[1])),
      ),
    );
  } catch {
    return null;
  }
}

function launchFromServerConfig(server: Record<string, unknown> | null): InstalledMcpLaunch | null {
  if (!server || typeof server.command !== "string") return null;
  return {
    command: server.command,
    args: Array.isArray(server.args) ? server.args.map((value) => String(value)) : [],
    env: stringRecord(server.env) ?? {},
  };
}

function tomlInlineStringTable(value: string): Record<string, string> | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return {};
  const entries: Array<[string, string]> = [];
  const pattern = /("(?:\\.|[^"\\])*")\s*=\s*("(?:\\.|[^"\\])*")/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(inner)) !== null) {
    entries.push([JSON.parse(match[1]!) as string, JSON.parse(match[2]!) as string]);
  }
  const residue = inner.replace(pattern, "").replaceAll(",", "").trim();
  return residue ? null : Object.fromEntries(entries);
}

function jsonProfileLaunches(path: string): InstalledMcpProfileLaunches {
  const servers = readJsonMcpServers(path) ?? {};
  return {
    legacy: launchFromServerConfig(servers[MCP_SERVER_NAMES.legacy] ?? null),
    core: launchFromServerConfig(servers[MCP_SERVER_NAMES.core] ?? null),
    memory: launchFromServerConfig(servers[MCP_SERVER_NAMES.memory] ?? null),
    actions: launchFromServerConfig(servers[MCP_SERVER_NAMES.actions] ?? null),
  };
}

function codexProfileLaunches(path: string): InstalledMcpProfileLaunches {
  const found: Record<string, InstalledMcpLaunch> = {};
  if (!existsSync(path)) return emptyLaunches();
  let activeName: string | null = null;
  let command: string | null = null;
  let args: string[] = [];
  let env: Record<string, string> = {};
  const flush = () => {
    if (activeName && command !== null) found[activeName] = { command, args, env };
    command = null;
    args = [];
    env = {};
  };
  for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
    const header = line.trim().match(/^\[([^\]]+)\]$/u)?.[1];
    if (header !== undefined) {
      flush();
      const match = /^mcp_servers\.(?:"([^"]+)"|(.+))$/u.exec(header);
      const name = match?.[1] ?? match?.[2] ?? null;
      activeName = name && isManagedMcpServerName(name) ? name : null;
      continue;
    }
    if (!activeName) continue;
    const commandValue = line.trim().match(/^command\s*=\s*(".*")$/u)?.[1];
    if (commandValue) command = JSON.parse(commandValue) as string;
    const argsValue = line.trim().match(/^args\s*=\s*(\[.*\])$/u)?.[1];
    if (argsValue) args = (JSON.parse(argsValue) as unknown[]).map((value) => String(value));
    const envValue = line.trim().match(/^env\s*=\s*(\{.*\})$/u)?.[1];
    if (envValue) env = tomlInlineStringTable(envValue) ?? {};
  }
  flush();
  return {
    legacy: found[MCP_SERVER_NAMES.legacy] ?? null,
    core: found[MCP_SERVER_NAMES.core] ?? null,
    memory: found[MCP_SERVER_NAMES.memory] ?? null,
    actions: found[MCP_SERVER_NAMES.actions] ?? null,
  };
}

export function installedCodexProfileLaunches(
  path = defaultCodexConfigPath(),
): InstalledMcpProfileLaunches {
  return codexProfileLaunches(path);
}

export function installedCodexLaunch(path = defaultCodexConfigPath()): InstalledMcpLaunch | null {
  const launches = installedCodexProfileLaunches(path);
  return launches.core ?? launches.legacy;
}

export function installedClaudeProfileLaunches(
  path = defaultClaudeConfigPath(),
): InstalledMcpProfileLaunches {
  return jsonProfileLaunches(path);
}

export function installedClaudeLaunch(path = defaultClaudeConfigPath()): InstalledMcpLaunch | null {
  const launches = installedClaudeProfileLaunches(path);
  return launches.core ?? launches.legacy;
}

export function installedClaudeProfileLaunchSets(): InstalledMcpProfileLaunches[] {
  return claudeDesktopConfigPaths().map((path) => installedClaudeProfileLaunches(path));
}

export function installedClaudeLaunches(): InstalledMcpLaunch[] {
  return claudeDesktopConfigPaths()
    .map((path) => installedClaudeLaunch(path))
    .filter((launch): launch is InstalledMcpLaunch => launch !== null);
}

export function installedClaudeCodeProfileLaunches(
  path = defaultClaudeCodeConfigPath(),
): InstalledMcpProfileLaunches {
  return jsonProfileLaunches(path);
}

export function installedClaudeCodeLaunch(
  path = defaultClaudeCodeConfigPath(),
): InstalledMcpLaunch | null {
  const launches = installedClaudeCodeProfileLaunches(path);
  return launches.core ?? launches.legacy;
}

export function readClaudeCodeManagedConfigs(
  path: string,
): Record<string, Record<string, unknown>> {
  const servers = readJsonMcpServers(path) ?? {};
  return Object.fromEntries(
    Object.entries(servers).filter(([name]) => isManagedMcpServerName(name)),
  );
}

export function serverConfigMatches(
  current: Record<string, unknown> | undefined,
  desired: McpInstallInput,
): boolean {
  if (!current || current.command !== desired.command) return false;
  const currentArgs = Array.isArray(current.args) ? current.args.map(String) : [];
  if (JSON.stringify(currentArgs) !== JSON.stringify(desired.args ?? [])) return false;
  const currentEnv = stringRecord(current.env) ?? {};
  const desiredEnv = desired.env ?? {};
  return (
    JSON.stringify(Object.entries(currentEnv).sort()) ===
    JSON.stringify(Object.entries(desiredEnv).sort())
  );
}

function installedProfileSetMatches(
  installed: InstalledMcpProfileLaunches,
  profiles?: readonly McpProfile[],
): boolean {
  const enabled = new Set(enabledMcpProfiles(profiles));
  return (
    installed.legacy === null &&
    (installed.core !== null) === enabled.has("core") &&
    (installed.memory !== null) === enabled.has("memory") &&
    (installed.actions !== null) === enabled.has("actions")
  );
}

export function isCodexConfigInstalled(
  path = defaultCodexConfigPath(),
  profiles?: readonly McpProfile[],
): boolean {
  return installedProfileSetMatches(installedCodexProfileLaunches(path), profiles);
}

export function isClaudeConfigInstalled(path?: string, profiles?: readonly McpProfile[]): boolean {
  if (path === undefined)
    return claudeDesktopConfigPaths().some((each) => isClaudeConfigInstalled(each, profiles));
  return installedProfileSetMatches(installedClaudeProfileLaunches(path), profiles);
}

export function isClaudeCodeConfigInstalled(
  path = defaultClaudeCodeConfigPath(),
  profiles?: readonly McpProfile[],
): boolean {
  const servers = readJsonMcpServers(path);
  const enabled = new Set<string>(
    enabledMcpProfiles(profiles).map((profile) => MCP_SERVER_NAMES[profile]),
  );
  return Object.values(MCP_SERVER_NAMES).every(
    (name) => Boolean(servers?.[name]) === enabled.has(name),
  );
}

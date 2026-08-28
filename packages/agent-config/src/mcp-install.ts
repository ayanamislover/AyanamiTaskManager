import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { AGENT_RULE_SNIPPET } from "./agent-rules.js";
import { replaceFileWithBackup } from "./atomic-files.js";
import {
  enabledMcpProfiles,
  isManagedMcpServerName,
  MCP_SERVER_NAMES,
  profileLaunch,
  type ClaudeCodeCliRunner,
  type InstallResult,
  type McpProfile,
  type McpRuntime,
} from "./contracts.js";
import {
  claudeDesktopConfigPaths,
  defaultClaudeCodeConfigPath,
  defaultCodexConfigPath,
  findClaudeCodeCli,
} from "./mcp-paths.js";
import { readClaudeCodeManagedConfigs, serverConfigMatches } from "./mcp-inspection.js";

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function isManagedCodexSection(header: string): boolean {
  return Object.values(MCP_SERVER_NAMES).some((name) =>
    [`mcp_servers.${name}`, `mcp_servers.${JSON.stringify(name)}`].some(
      (root) => header === root || header.startsWith(`${root}.`),
    ),
  );
}

function withoutOwnCodexSection(content: string): string {
  const output: string[] = [];
  let skipping = false;
  for (const line of content.split(/\r?\n/u)) {
    const header = line.trim().match(/^\[([^\]]+)\]$/u)?.[1];
    if (header) {
      skipping = isManagedCodexSection(header);
      if (skipping) continue;
    }
    if (!skipping) output.push(line);
  }
  return output.join("\n").trimEnd();
}

export function uninstallCodexConfig(path = defaultCodexConfigPath()): InstallResult {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const next = withoutOwnCodexSection(existing);
  const content = next ? `${next}\n` : "";
  const backupPath = existing === content ? null : replaceFileWithBackup(path, content);
  return { client: "CODEX", path, backupPath };
}

export function uninstallClaudeConfig(path?: string): InstallResult {
  if (path === undefined) {
    const results = claudeDesktopConfigPaths().map((each) => uninstallClaudeConfig(each));
    return results.find((result) => result.backupPath !== null) ?? results[0]!;
  }
  if (!existsSync(path)) return { client: "CLAUDE", path, backupPath: null };
  let existing: Record<string, unknown>;
  try {
    existing = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("CLAUDE_CONFIG_INVALID_JSON");
  }
  const currentServers =
    existing.mcpServers && typeof existing.mcpServers === "object"
      ? (existing.mcpServers as Record<string, unknown>)
      : {};
  const servers = { ...currentServers };
  for (const name of Object.values(MCP_SERVER_NAMES)) delete servers[name];
  const content = `${JSON.stringify({ ...existing, mcpServers: servers }, null, 2)}\n`;
  const current = readFileSync(path, "utf8");
  const backupPath = current === content ? null : replaceFileWithBackup(path, content);
  return { client: "CLAUDE", path, backupPath };
}

export function installClaudeCodeConfig(input: {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cliPath?: string;
  findCli?: () => string | null;
  configPath?: string;
  runCli?: ClaudeCodeCliRunner;
  profiles?: readonly McpProfile[];
}): InstallResult {
  const cli = input.cliPath ?? (input.findCli ?? findClaudeCodeCli)();
  if (!cli) throw new Error("CLAUDE_CODE_CLI_NOT_FOUND");
  const run = input.runCli ?? runClaudeCodeCli;
  const path = input.configPath ?? defaultClaudeCodeConfigPath();
  const previous = readClaudeCodeManagedConfigs(path);
  const desired = Object.fromEntries(
    enabledMcpProfiles(input.profiles).map((profile) => [
      MCP_SERVER_NAMES[profile],
      profileLaunch(input, profile),
    ]),
  );
  const unchanged =
    Object.values(MCP_SERVER_NAMES).every(
      (name) => desired[name] !== undefined || previous[name] === undefined,
    ) &&
    Object.entries(desired).every(([name, config]) => serverConfigMatches(previous[name], config));
  if (unchanged) return { client: "CLAUDE_CODE", path, backupPath: null };

  const removed: Array<[string, Record<string, unknown>]> = [];
  const added: string[] = [];
  try {
    for (const name of Object.values(MCP_SERVER_NAMES)) {
      const config = previous[name];
      if (!config) continue;
      run(cli, ["mcp", "remove", name, "--scope", "user"]);
      removed.push([name, config]);
    }
    for (const [name, config] of Object.entries(desired)) {
      run(cli, ["mcp", "add-json", name, JSON.stringify(config), "--scope", "user"]);
      added.push(name);
    }
  } catch (error) {
    try {
      for (const name of added.reverse()) {
        run(cli, ["mcp", "remove", name, "--scope", "user"]);
      }
      for (const [name, config] of removed) {
        run(cli, ["mcp", "add-json", name, JSON.stringify(config), "--scope", "user"]);
      }
    } catch (rollbackError) {
      throw new Error(
        `CLAUDE_CODE_INSTALL_AND_ROLLBACK_FAILED: ${error instanceof Error ? error.message : String(error)}; rollback: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        { cause: error },
      );
    }
    throw error;
  }
  return { client: "CLAUDE_CODE", path, backupPath: null };
}

const runClaudeCodeCli: ClaudeCodeCliRunner = (cli, args) => {
  try {
    const isWindowsCommandShim =
      process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(cli.toLowerCase());
    execFileSync(cli, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: isWindowsCommandShim,
    });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(`CLAUDE_CODE_CLI_FAILED: ${stderr || (error as Error).message}`);
  }
};

export function uninstallClaudeCodeConfig(
  input: {
    cliPath?: string;
    findCli?: () => string | null;
    configPath?: string;
    runCli?: ClaudeCodeCliRunner;
  } = {},
): InstallResult {
  const path = input.configPath ?? defaultClaudeCodeConfigPath();
  const installed = readClaudeCodeManagedConfigs(path);
  if (Object.keys(installed).length === 0) return { client: "CLAUDE_CODE", path, backupPath: null };
  const cli = input.cliPath ?? (input.findCli ?? findClaudeCodeCli)();
  if (!cli) throw new Error("CLAUDE_CODE_CLI_NOT_FOUND");
  for (const name of Object.values(MCP_SERVER_NAMES)) {
    if (!installed[name]) continue;
    (input.runCli ?? runClaudeCodeCli)(cli, ["mcp", "remove", name, "--scope", "user"]);
  }
  return { client: "CLAUDE_CODE", path, backupPath: null };
}

export function installCodexConfig(input: {
  path?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  profiles?: readonly McpProfile[];
}): InstallResult {
  const path = input.path ?? defaultCodexConfigPath();
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const base = withoutOwnCodexSection(existing);
  const sections = enabledMcpProfiles(input.profiles).map((profile) => {
    const launch = profileLaunch(input, profile);
    return [
      `[mcp_servers.${tomlString(MCP_SERVER_NAMES[profile])}]`,
      `command = ${tomlString(launch.command)}`,
      `args = [${launch.args!.map(tomlString).join(", ")}]`,
      ...(launch.env && Object.keys(launch.env).length > 0
        ? [
            `env = { ${Object.entries(launch.env)
              .map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`)
              .join(", ")} }`,
          ]
        : []),
    ].join("\n");
  });
  const content = `${base}${base ? "\n\n" : ""}${sections.join("\n\n")}\n`;
  const backupPath = existing === content ? null : replaceFileWithBackup(path, content);
  return { client: "CODEX", path, backupPath };
}

export function installClaudeConfig(input: {
  path?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  profiles?: readonly McpProfile[];
}): InstallResult {
  if (input.path === undefined) {
    const results = claudeDesktopConfigPaths().map((path) =>
      installClaudeConfig({ ...input, path }),
    );
    return results[0]!;
  }
  const path = input.path;
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      throw new Error("CLAUDE_CONFIG_INVALID_JSON");
    }
  }
  const currentServers =
    existing.mcpServers && typeof existing.mcpServers === "object"
      ? (existing.mcpServers as Record<string, unknown>)
      : {};
  const preservedServers = Object.fromEntries(
    Object.entries(currentServers).filter(([name]) => !isManagedMcpServerName(name)),
  );
  const managedServers = Object.fromEntries(
    enabledMcpProfiles(input.profiles).map((profile) => {
      const launch = profileLaunch(input, profile);
      return [
        MCP_SERVER_NAMES[profile],
        {
          command: launch.command,
          args: launch.args,
          ...(launch.env ? { env: launch.env } : {}),
        },
      ];
    }),
  );
  const merged = {
    ...existing,
    mcpServers: { ...preservedServers, ...managedServers },
  };
  const content = `${JSON.stringify(merged, null, 2)}\n`;
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const backupPath = current === content ? null : replaceFileWithBackup(path, content);
  return { client: "CLAUDE", path, backupPath };
}

export function renderMcpConfigs(
  runtime: McpRuntime,
  profiles?: readonly McpProfile[],
): {
  streamableHttp: string;
  stdio: string;
  generic: string;
  agentRule: string;
} {
  const rendered = enabledMcpProfiles(profiles);
  const httpServers = Object.fromEntries(
    rendered.map((profile) => [
      MCP_SERVER_NAMES[profile],
      {
        type: "streamable-http",
        url: `${runtime.endpoint.replace(/\/$/u, "")}/mcp/${profile}`,
        headers: { Authorization: `Bearer ${runtime.token}` },
      },
    ]),
  );
  const stdioServers = Object.fromEntries(
    rendered.map((profile) => {
      const launch = profileLaunch(runtime, profile);
      return [
        MCP_SERVER_NAMES[profile],
        {
          command: launch.command,
          args: launch.args,
          ...(launch.env ? { env: launch.env } : {}),
        },
      ];
    }),
  );
  return {
    streamableHttp: `${JSON.stringify({ mcpServers: httpServers }, null, 2)}\n`,
    stdio: `${JSON.stringify({ mcpServers: stdioServers }, null, 2)}\n`,
    generic: `${JSON.stringify({ mcpServers: stdioServers }, null, 2)}\n`,
    agentRule: AGENT_RULE_SNIPPET,
  };
}

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const AGENT_RULE_SNIPPET =
  "执行项目前先访问 ATM 工具，并阅读 R:\\Project_All\\AyanamiTaskManager\\ATM_AGENT_GUIDE.md；后续所有任务执行均依赖 ATM。";

export type McpRuntime = {
  endpoint: string;
  token: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
};
export type InstallResult = { client: "CODEX" | "CLAUDE"; path: string; backupPath: string | null };

function backupName(path: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  return `${path}.bak-${stamp}-${randomBytes(3).toString("hex")}`;
}

function replaceFileWithBackup(path: string, content: string): string | null {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  if (!existsSync(path)) {
    renameSync(temporary, path);
    return null;
  }
  const backupPath = backupName(path);
  renameSync(path, backupPath);
  try {
    renameSync(temporary, path);
    return backupPath;
  } catch (error) {
    if (!existsSync(path) && existsSync(backupPath)) renameSync(backupPath, path);
    throw error;
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function withoutOwnCodexSection(content: string): string {
  const output: string[] = [];
  let skipping = false;
  for (const line of content.split(/\r?\n/u)) {
    const header = line.trim().match(/^\[([^\]]+)\]$/u)?.[1];
    if (header) {
      skipping = new Set([
        'mcp_servers."ayanami-task-manager"',
        "mcp_servers.ayanami-task-manager",
      ]).has(header);
      if (skipping) continue;
    }
    if (!skipping) output.push(line);
  }
  return output.join("\n").trimEnd();
}

export function defaultCodexConfigPath(): string {
  return join(homedir(), ".codex", "config.toml");
}

export function defaultClaudeConfigPath(): string {
  return join(
    process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
    "Claude",
    "claude_desktop_config.json",
  );
}

export function installCodexConfig(input: {
  path?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}): InstallResult {
  const path = input.path ?? defaultCodexConfigPath();
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const base = withoutOwnCodexSection(existing);
  const own = [
    '[mcp_servers."ayanami-task-manager"]',
    `command = ${tomlString(input.command)}`,
    `args = [${(input.args ?? ["--mcp-stdio"]).map(tomlString).join(", ")}]`,
    ...(input.env && Object.keys(input.env).length > 0
      ? [
          `env = { ${Object.entries(input.env)
            .map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`)
            .join(", ")} }`,
        ]
      : []),
  ].join("\n");
  const backupPath = replaceFileWithBackup(path, `${base}${base ? "\n\n" : ""}${own}\n`);
  return { client: "CODEX", path, backupPath };
}

export function installClaudeConfig(input: {
  path?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}): InstallResult {
  const path = input.path ?? defaultClaudeConfigPath();
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
  const merged = {
    ...existing,
    mcpServers: {
      ...currentServers,
      "ayanami-task-manager": {
        command: input.command,
        args: input.args ?? ["--mcp-stdio"],
        ...(input.env ? { env: input.env } : {}),
      },
    },
  };
  const backupPath = replaceFileWithBackup(path, `${JSON.stringify(merged, null, 2)}\n`);
  return { client: "CLAUDE", path, backupPath };
}

export function renderMcpConfigs(runtime: McpRuntime): {
  streamableHttp: string;
  stdio: string;
  generic: string;
  agentRule: string;
} {
  const httpServer = {
    type: "streamable-http",
    url: `${runtime.endpoint.replace(/\/$/u, "")}/mcp`,
    headers: { Authorization: `Bearer ${runtime.token}` },
  };
  const stdioServer = {
    command: runtime.command,
    args: runtime.args ?? ["--mcp-stdio"],
    ...(runtime.env ? { env: runtime.env } : {}),
  };
  return {
    streamableHttp: `${JSON.stringify({ mcpServers: { "ayanami-task-manager": httpServer } }, null, 2)}\n`,
    stdio: `${JSON.stringify({ mcpServers: { "ayanami-task-manager": stdioServer } }, null, 2)}\n`,
    generic: `${JSON.stringify({ mcpServers: { "ayanami-task-manager": httpServer } }, null, 2)}\n`,
    agentRule: AGENT_RULE_SNIPPET,
  };
}

import { existsSync, readFileSync } from "node:fs";
import { replaceFileWithBackup } from "./atomic-files.js";
import {
  enabledMcpProfiles,
  isManagedMcpServerName,
  MCP_SERVER_NAMES,
  profileLaunch,
  type InstallResult,
  type McpInstallInput,
  type McpProfile,
} from "./contracts.js";
import { defaultKimiCodeConfigPath } from "./mcp-paths.js";

/**
 * Kimi Code 的 MCP 配置是 `~/.kimi-code/mcp.json`：`{ mcpServers: { name: { transport, command,
 * args, env } } }`。写法照 Claude Desktop：只换 ATM 自己的几个服务，其他服务与顶层键原样保留，
 * 内容有变化才先备份再原子替换。和 Claude 不同的是 Kimi 要求每个服务写明 `transport`。
 */
function readKimiConfig(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("KIMI_CODE_CONFIG_INVALID_JSON");
  }
}

function serversOf(config: Record<string, unknown>): Record<string, unknown> {
  const servers = config.mcpServers;
  return servers && typeof servers === "object" && !Array.isArray(servers)
    ? (servers as Record<string, unknown>)
    : {};
}

function writeIfChanged(path: string, next: Record<string, unknown>): string | null {
  const content = `${JSON.stringify(next, null, 2)}\n`;
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  return current === content ? null : replaceFileWithBackup(path, content);
}

export function installKimiCodeConfig(
  input: McpInstallInput & { path?: string; profiles?: readonly McpProfile[] },
): InstallResult {
  const path = input.path ?? defaultKimiCodeConfigPath();
  const existing = readKimiConfig(path) ?? {};
  const preserved = Object.fromEntries(
    Object.entries(serversOf(existing)).filter(([name]) => !isManagedMcpServerName(name)),
  );
  const managed = Object.fromEntries(
    enabledMcpProfiles(input.profiles).map((profile) => {
      const launch = profileLaunch(input, profile);
      return [
        MCP_SERVER_NAMES[profile],
        {
          transport: "stdio",
          command: launch.command,
          args: launch.args,
          ...(launch.env ? { env: launch.env } : {}),
        },
      ];
    }),
  );
  const backupPath = writeIfChanged(path, {
    ...existing,
    mcpServers: { ...preserved, ...managed },
  });
  return { client: "KIMI_CODE", path, backupPath };
}

export function uninstallKimiCodeConfig(path = defaultKimiCodeConfigPath()): InstallResult {
  const existing = readKimiConfig(path);
  if (!existing) return { client: "KIMI_CODE", path, backupPath: null };
  const servers = { ...serversOf(existing) };
  for (const name of Object.values(MCP_SERVER_NAMES)) delete servers[name];
  const backupPath = writeIfChanged(path, { ...existing, mcpServers: servers });
  return { client: "KIMI_CODE", path, backupPath };
}

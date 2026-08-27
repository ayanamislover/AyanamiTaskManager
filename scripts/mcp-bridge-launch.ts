import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MCP_RUNTIME_LINK, mcpLaunch } from "../apps/desktop/src/mcp-launch.js";

export type McpProfile = "core" | "memory";

export type ConfiguredBridgeLaunch = {
  command: string;
  args: string[];
  env: Record<string, string>;
  source: "configured" | "legacy" | "fallback";
};

type ServerEntry = { command?: unknown; args?: unknown; env?: unknown };

function normalizedEntry(
  entry: ServerEntry | undefined,
  source: ConfiguredBridgeLaunch["source"],
): ConfiguredBridgeLaunch | null {
  if (!entry || typeof entry.command !== "string") return null;
  return {
    command: entry.command,
    args: Array.isArray(entry.args) ? entry.args.map(String) : [],
    env:
      entry.env && typeof entry.env === "object" && !Array.isArray(entry.env)
        ? Object.fromEntries(
            Object.entries(entry.env as Record<string, unknown>).filter(
              (item): item is [string, string] => typeof item[1] === "string",
            ),
          )
        : {},
    source,
  };
}

export function configuredBridgeLaunch(input: {
  profile: McpProfile;
  configPath?: string;
  dataDir: string;
}): ConfiguredBridgeLaunch {
  const configPath = input.configPath ?? join(homedir(), ".claude.json");
  if (existsSync(configPath)) {
    const servers = (
      JSON.parse(readFileSync(configPath, "utf8")) as {
        mcpServers?: Record<string, ServerEntry>;
      }
    ).mcpServers;
    const configured = normalizedEntry(
      servers?.[`ayanami-task-manager-${input.profile}`],
      "configured",
    );
    if (configured) return configured;
    if (input.profile === "core") {
      const legacy = normalizedEntry(servers?.["ayanami-task-manager"], "legacy");
      if (legacy) return legacy;
    }
  }
  const launch = mcpLaunch({
    execPath: join(input.dataDir, MCP_RUNTIME_LINK, "AyanamiTaskManager.exe"),
    dataDir: input.dataDir,
  });
  return { ...launch, args: [...launch.args, "--profile", input.profile], source: "fallback" };
}

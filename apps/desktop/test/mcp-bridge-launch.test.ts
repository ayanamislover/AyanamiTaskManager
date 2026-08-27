import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configuredBridgeLaunch } from "../../../scripts/mcp-bridge-launch.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("MCP bridge 内存诊断的真实配置选择", () => {
  it("按指定 Profile 读取新双 key，legacy 只兼容 core", () => {
    const root = mkdtempSync(join(tmpdir(), "atm-bridge-config-"));
    temporary.push(root);
    const configPath = join(root, ".claude.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          other: { command: "other" },
          "ayanami-task-manager-core": {
            command: "configured.exe",
            args: ["bridge.cjs", "--profile", "core"],
            env: { CORE: "1" },
          },
          "ayanami-task-manager-memory": {
            command: "configured.exe",
            args: ["bridge.cjs", "--profile", "memory"],
            env: { MEMORY: "1" },
          },
        },
      }),
      "utf8",
    );

    expect(configuredBridgeLaunch({ profile: "core", configPath, dataDir: root })).toEqual({
      command: "configured.exe",
      args: ["bridge.cjs", "--profile", "core"],
      env: { CORE: "1" },
      source: "configured",
    });
    expect(configuredBridgeLaunch({ profile: "memory", configPath, dataDir: root })).toEqual({
      command: "configured.exe",
      args: ["bridge.cjs", "--profile", "memory"],
      env: { MEMORY: "1" },
      source: "configured",
    });

    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: { "ayanami-task-manager": { command: "legacy.exe", args: ["legacy.cjs"] } },
      }),
      "utf8",
    );
    expect(configuredBridgeLaunch({ profile: "core", configPath, dataDir: root })).toMatchObject({
      command: "legacy.exe",
      source: "legacy",
    });
    expect(configuredBridgeLaunch({ profile: "memory", configPath, dataDir: root })).toMatchObject({
      args: [join(root, "mcp-stdio.cjs"), "--profile", "memory"],
      source: "fallback",
    });
  });
});

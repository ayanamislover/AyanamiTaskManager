import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installedKimiCodeProfileLaunches,
  installKimiCodeConfig,
  isKimiCodeConfigInstalled,
  uninstallKimiCodeConfig,
} from "../src/index.js";

// Kimi Code 的 ~/.kimi-code/mcp.json 由 ATM 托管：只动 ATM 自己的服务，别的服务和顶层键原样留下。

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function configPath(content?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "atm-kimi-config-"));
  roots.push(root);
  const path = join(root, "mcp.json");
  if (content !== undefined)
    writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

const launch = { command: "C:\\ATM\\atm-mcp.exe", args: [], env: {} };
const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;

describe("Kimi Code MCP 配置", () => {
  it("写入三个档位并标明 stdio；其他服务与顶层键原样保留", () => {
    const path = configPath({
      theme: "dark",
      mcpServers: {
        github: { transport: "stdio", command: "gh-mcp", env: { GITHUB_TOKEN: "keep-me" } },
        "ayanami-task-manager": { command: "old-legacy" },
      },
    });
    const result = installKimiCodeConfig({ path, ...launch });
    expect(result).toMatchObject({ client: "KIMI_CODE", path });
    expect(result.backupPath).not.toBeNull();
    const written = read(path);
    expect(written.theme).toBe("dark");
    expect(written.mcpServers.github).toEqual({
      transport: "stdio",
      command: "gh-mcp",
      env: { GITHUB_TOKEN: "keep-me" },
    });
    // 旧版单服务名被换成三个档位。
    expect(written.mcpServers["ayanami-task-manager"]).toBeUndefined();
    expect(written.mcpServers["ayanami-task-manager-core"]).toEqual({
      transport: "stdio",
      command: "C:\\ATM\\atm-mcp.exe",
      args: ["--profile", "core"],
      env: {},
    });
    expect(Object.keys(written.mcpServers).sort()).toEqual([
      "ayanami-task-manager-actions",
      "ayanami-task-manager-core",
      "ayanami-task-manager-memory",
      "github",
    ]);
    expect(isKimiCodeConfigInstalled(path)).toBe(true);
    expect(installedKimiCodeProfileLaunches(path).memory?.args).toEqual(["--profile", "memory"]);
  });

  it("重复安装不改文件也不留备份；只开 core 时移除另外两个档位", () => {
    const path = configPath();
    expect(installKimiCodeConfig({ path, ...launch }).backupPath).toBeNull();
    expect(existsSync(path)).toBe(true);
    expect(installKimiCodeConfig({ path, ...launch }).backupPath).toBeNull();
    installKimiCodeConfig({ path, ...launch, profiles: ["core"] });
    expect(Object.keys(read(path).mcpServers)).toEqual(["ayanami-task-manager-core"]);
    expect(isKimiCodeConfigInstalled(path, ["core"])).toBe(true);
    expect(isKimiCodeConfigInstalled(path)).toBe(false);
  });

  it("卸载只删 ATM 的服务（含旧版名），文件不存在时什么都不做", () => {
    const path = configPath({
      mcpServers: {
        github: { command: "gh-mcp" },
        "ayanami-task-manager": { command: "old" },
        "ayanami-task-manager-core": { command: "atm" },
      },
    });
    const result = uninstallKimiCodeConfig(path);
    expect(result.backupPath).not.toBeNull();
    expect(read(path).mcpServers).toEqual({ github: { command: "gh-mcp" } });
    expect(isKimiCodeConfigInstalled(path)).toBe(false);
    const missing = join(tmpdir(), "atm-kimi-config-missing", "mcp.json");
    expect(uninstallKimiCodeConfig(missing)).toEqual({
      client: "KIMI_CODE",
      path: missing,
      backupPath: null,
    });
    expect(existsSync(missing)).toBe(false);
  });

  it("配置不是合法 JSON 时拒绝写入，原文件不动", () => {
    const path = configPath("{ not json");
    expect(() => installKimiCodeConfig({ path, ...launch })).toThrow(
      "KIMI_CODE_CONFIG_INVALID_JSON",
    );
    expect(() => uninstallKimiCodeConfig(path)).toThrow("KIMI_CODE_CONFIG_INVALID_JSON");
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });
});

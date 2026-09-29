import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectKimiCodeConfig } from "../src/index.js";

// Kimi Code 目前是用户手动配置的：ATM 只读它的 mcp.json，报告登记了哪几个 ATM profile。

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function configFile(content: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "atm-kimi-inspect-"));
  roots.push(root);
  const path = join(root, "mcp.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

describe("Kimi Code 接入检测", () => {
  it("按服务名列出已登记的 ATM profile，其他服务不算", () => {
    const path = configFile({
      mcpServers: {
        github: { command: "gh-mcp", env: { GITHUB_TOKEN: "secret-value" } },
        "ayanami-task-manager-core": { command: "atm", args: ["core"] },
        "ayanami-task-manager-actions": { command: "atm", args: ["actions"] },
      },
    });
    const status = inspectKimiCodeConfig(path);
    expect(status).toEqual({ configPath: path, profiles: ["core", "actions"] });
    // 只回报服务名：别的服务的凭证不会被带进结果。
    expect(JSON.stringify(status)).not.toContain("secret-value");
  });

  it("旧版单服务名不算三个 profile 之一；文件缺失或损坏时报告未接入", () => {
    expect(
      inspectKimiCodeConfig(configFile({ mcpServers: { "ayanami-task-manager": {} } })).profiles,
    ).toEqual([]);
    expect(inspectKimiCodeConfig(configFile("{ not json")).profiles).toEqual([]);
    expect(inspectKimiCodeConfig(join(tmpdir(), "atm-kimi-missing", "mcp.json")).profiles).toEqual(
      [],
    );
  });
});

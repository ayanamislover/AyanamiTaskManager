import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installAgentDocumentation } from "../src/agent-documentation.js";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Agent 文档正式数据根分发", () => {
  it("安装并更新 Guide 与完整 docs 树", () => {
    const root = mkdtempSync(join(tmpdir(), "atm-agent-docs-"));
    temporary.push(root);
    const bundled = join(root, "bundled");
    const dataDir = join(root, "data");
    mkdirSync(join(bundled, "docs", "adr"), { recursive: true });
    writeFileSync(join(bundled, "ATM_AGENT_GUIDE.md"), "guide-v1\n", "utf8");
    writeFileSync(join(bundled, "docs", "agent-integration.md"), "integration-v1\n", "utf8");
    writeFileSync(join(bundled, "docs", "adr", "ADR-001.md"), "adr-v1\n", "utf8");

    const first = installAgentDocumentation(bundled, dataDir);
    expect(first.guidePath).toBe(join(dataDir, "ATM_AGENT_GUIDE.md"));
    expect(readFileSync(first.guidePath, "utf8")).toBe("guide-v1\n");
    expect(readFileSync(join(dataDir, "docs", "agent-integration.md"), "utf8")).toBe(
      "integration-v1\n",
    );
    expect(readFileSync(join(dataDir, "docs", "adr", "ADR-001.md"), "utf8")).toBe("adr-v1\n");

    writeFileSync(join(bundled, "ATM_AGENT_GUIDE.md"), "guide-v2\n", "utf8");
    writeFileSync(join(bundled, "docs", "agent-integration.md"), "integration-v2\n", "utf8");
    installAgentDocumentation(bundled, dataDir);
    expect(readFileSync(join(dataDir, "ATM_AGENT_GUIDE.md"), "utf8")).toBe("guide-v2\n");
    expect(readFileSync(join(dataDir, "docs", "agent-integration.md"), "utf8")).toBe(
      "integration-v2\n",
    );
  });
});

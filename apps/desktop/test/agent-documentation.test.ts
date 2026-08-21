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
    for (const name of ["atm-plan", "atm-task"]) {
      const skill = join(bundled, "integrations", "skills", name);
      mkdirSync(skill, { recursive: true });
      writeFileSync(join(skill, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8");
    }
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

  it("随包分发交互式自动注册、原子 Session 边界与拆分规则", () => {
    const root = mkdtempSync(join(tmpdir(), "atm-agent-policy-"));
    temporary.push(root);
    const dataDir = join(root, "data");

    installAgentDocumentation(process.cwd(), dataDir);
    const installed = readFileSync(join(dataDir, "docs", "agent-integration.md"), "utf8");
    expect(installed).toContain("普通交互式开工可在受管开发任务未注册时自动创建");
    expect(installed).toContain("需要崩溃重放的自动化控制器必须先注册项目，并携带稳定 `op_id`");
    expect(installed).toContain("该保证的键空间是 `(project, op_id)`");
    expect(installed).toContain("必须验证该回执");
    expect(installed).toContain("ATOMIC_BEGIN_REQUIRES_EXISTING_PROJECT");
    expect(installed).not.toContain("若项目未注册，先由用户确认是否创建");
    expect(installed).toContain("拆成多个可独立完成和验收的子 WorkItem");
    const guide = readFileSync(join(dataDir, "ATM_AGENT_GUIDE.md"), "utf8");
    expect(guide).toContain("拆成多个可独立完成和验收的子 WorkItem");
  });

  it("把 atm-plan 与 atm-task Skills 发布到设备无关数据根", () => {
    const root = mkdtempSync(join(tmpdir(), "atm-agent-skills-"));
    temporary.push(root);
    const dataDir = join(root, "data");

    const installed = installAgentDocumentation(process.cwd(), dataDir);

    expect(installed.skillsPath).toBe(join(dataDir, "skills"));
    expect(readFileSync(join(installed.skillsPath, "atm-plan", "SKILL.md"), "utf8")).toContain(
      "name: atm-plan",
    );
    expect(readFileSync(join(installed.skillsPath, "atm-task", "SKILL.md"), "utf8")).toContain(
      "name: atm-task",
    );
  });
});

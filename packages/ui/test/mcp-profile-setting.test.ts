import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("memory Profile 设置说明", () => {
  it("默认完整工具面，并明确低内存降级损失与客户端重载要求", () => {
    const source = readFileSync(
      join(process.cwd(), "packages", "ui", "src", "features", "settings.tsx"),
      "utf8",
    );
    expect(source).toContain("默认开启");
    expect(source).toContain("关闭后将失去");
    expect(source).toContain("atm_feedback");
    expect(source).toContain("六个工具");
    expect(source).toMatch(/重载或重启.*Agent 客户端/u);
    expect(source).toContain("memoryProfileError");
    expect(source).toContain("自动修复失败：");

    const integrationHostSource = readFileSync(
      join(process.cwd(), "apps", "desktop", "src", "main-agent-integrations.ts"),
      "utf8",
    );
    expect(integrationHostSource.match(/mcpRepairFailures\.delete\(client\)/gu)).toHaveLength(2);
  });
});

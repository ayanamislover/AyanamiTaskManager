import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("memory Profile 设置说明", () => {
  it("默认完整工具面，并明确低内存降级损失与客户端重载要求", () => {
    const source = readFileSync(join(process.cwd(), "packages", "ui", "src", "app.tsx"), "utf8");
    expect(source).toContain("默认开启");
    expect(source).toContain("关闭后将失去");
    expect(source).toMatch(/重载或重启.*Agent 客户端/u);
    expect(source).toContain("memoryProfileError");
    expect(source).toContain("自动修复失败：");

    const mainSource = readFileSync(
      join(process.cwd(), "apps", "desktop", "src", "main.ts"),
      "utf8",
    );
    expect(mainSource.match(/mcpRepairFailures\.delete\(client\)/gu)).toHaveLength(2);
  });
});

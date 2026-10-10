import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("memory Profile 设置说明", () => {
  it("默认完整工具面，并明确低内存降级损失与客户端重载要求", () => {
    // 接入卡片拆到了 agent-integration-card.tsx，两份一起看。
    const source = ["settings.tsx", "agent-integration-card.tsx"]
      .map((file) =>
        readFileSync(join(process.cwd(), "packages", "ui", "src", "features", file), "utf8"),
      )
      .join("\n");
    expect(source).toContain("默认开启");
    expect(source).toContain("关闭后将失去");
    // 3.0：actions 并入 core，memory 只剩搜索与共享知识四个工具（http/src/tools.rs MEMORY_TOOLS）。
    expect(source).toContain("atm_knowledge_save");
    expect(source).toContain("四个工具");
    expect(source).not.toContain("atm_task_patch、");
    expect(source).toMatch(/重载或重启.*Agent 客户端/u);
    expect(source).toContain("memoryProfileError");
    expect(source).toContain("自动修复失败：");

    // 修复失败的原因在用户再操作成功后清掉（atm-agents integrations.rs 的 clear_failure）。
    const integrationHostSource = readFileSync(
      join(process.cwd(), "apps", "desktop", "native", "agents", "src", "integrations.rs"),
      "utf8",
    );
    expect(
      integrationHostSource.match(/self\.clear_failure\(c\)/gu)?.length,
    ).toBeGreaterThanOrEqual(3);
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KimiCodeCardView } from "../src/features/kimi-code-card.js";

describe("设置页 Kimi Code 行", () => {
  it("配置里登记了 ATM 时显示已接入（手动配置）与 profile 列表", () => {
    const markup = renderToStaticMarkup(
      createElement(KimiCodeCardView, {
        status: { configPath: "C:\\Users\\me\\.kimi-code\\mcp.json", profiles: ["core", "memory"] },
      }),
    );
    expect(markup).toContain('<span class="atm-badge success">已接入（手动配置）</span>');
    expect(markup).toContain("core · memory");
    // 接管还没做：按钮在，但点不了，并说明原因。
    expect(markup).toMatch(
      /<button class="atm-button" disabled="" title="接管功能开发中">交给 ATM 管理<\/button>/u,
    );
  });

  it("配置里没有 ATM 时如实显示未接入", () => {
    const markup = renderToStaticMarkup(
      createElement(KimiCodeCardView, { status: { configPath: "x", profiles: [] } }),
    );
    expect(markup).toContain('<span class="atm-badge">未接入</span>');
    expect(markup).not.toContain("已接入");
  });
});

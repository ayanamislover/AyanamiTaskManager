import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { uiCssText } from "./css-source-graph.js";

// 滚动条 token（--atm-scrollbar-thumb）在柔彩改版里留下了，用它的规则却丢了：侧栏项目列表
// 露出 Windows 原生滚动条——中性灰轨道、灰滑块、两端箭头，暗色侧栏上是一条灰黑竖带。
describe("滚动条跟着柔彩走", () => {
  const css = uiCssText();
  const rule = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return css.match(new RegExp(`(?:^|[\\s,}])${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, "u"))?.[1];
  };

  it("滑块用柔彩 token、轨道透明、没有两端箭头，高对比度下交还系统", () => {
    expect(rule("::-webkit-scrollbar-thumb")).toMatch(/var\(--atm-scrollbar-thumb\)/u);
    expect(rule("::-webkit-scrollbar-thumb:hover")).toMatch(/var\(--atm-scrollbar-thumb-hover\)/u);
    expect(rule("::-webkit-scrollbar-track")).toMatch(/background:\s*transparent/u);
    expect(rule("::-webkit-scrollbar-button")).toMatch(/display:\s*none/u);
    expect(css).toMatch(/@media not \(forced-colors: active\)\s*\{\s*::-webkit-scrollbar\s*\{/u);
  });

  it("侧栏项目列表不设标准 scrollbar-color / scrollbar-width（会让上面的伪元素规则失效）", () => {
    const sidebarList = rule(".atm-sidebar-project-list");
    expect(sidebarList).toBeDefined();
    expect(sidebarList).not.toMatch(/scrollbar-(color|width)/u);
    const desktop = readFileSync(
      join(process.cwd(), "apps", "desktop", "src", "window-chrome.css"),
      "utf8",
    );
    expect(desktop).not.toMatch(/atm-sidebar-project-list[^{]*\{[^}]*scrollbar-(color|width)/u);
  });
});

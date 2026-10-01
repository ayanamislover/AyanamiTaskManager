import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 总览「项目状态」卡片：列数只能按实际宽度算，统计 chip 不许被截断。
// 曾经的回归：responsive.css 用同特指度、后加载的固定两列 / 三列盖掉了 280px 下限，
// 1101–1203px 的窗口里卡片被压窄，「Agent 0」这类 chip 被省略号吃掉数字。

const stylesDir = join(process.cwd(), "packages", "ui", "src", "styles");

type Rule = { file: string; selectors: string[]; body: string };

function rules(): Rule[] {
  return readdirSync(stylesDir)
    .filter((name) => name.endsWith(".css"))
    .flatMap((file) =>
      [
        ...readFileSync(join(stylesDir, file), "utf8")
          .replace(/\/\*[\s\S]*?\*\//gu, "")
          .matchAll(/([^{}]+)\{([^{}]*)\}/gu),
      ].map((match) => ({
        file,
        selectors: match[1]!.split(",").map((selector) => selector.trim()),
        body: match[2]!,
      })),
    );
}

const declaration = (body: string, property: string) =>
  [...body.matchAll(new RegExp(`(?:^|;|\\s)${property}\\s*:\\s*([^;]+)`, "gu"))].map((match) =>
    match[1]!.trim(),
  );

const rulesFor = (selector: string) => rules().filter((rule) => rule.selectors.includes(selector));

describe("总览项目卡片样式", () => {
  it("扫描能找到基准规则（阳性对照）", () => {
    expect(rulesFor(".atm-overview-projects").length).toBeGreaterThan(0);
    expect(rulesFor(".atm-project-stats span").length).toBeGreaterThan(0);
  });

  it("项目网格的列数只按实际宽度算，不进固定列数", () => {
    const columns = rulesFor(".atm-overview-projects").flatMap((rule) =>
      declaration(rule.body, "grid-template-columns").map((value) => `${rule.file}: ${value}`),
    );
    expect(columns.length).toBeGreaterThan(0);
    for (const entry of columns) {
      const value = entry.slice(entry.indexOf(": ") + 2);
      expect(
        value === "1fr" || value === "repeat(auto-fill, minmax(min(100%, 280px), 1fr))",
        entry,
      ).toBe(true);
    }
  });

  it("统计 chip 整格换行，不截断也不拆成两行", () => {
    const chips = rulesFor(".atm-project-stats span");
    for (const rule of chips) {
      expect(declaration(rule.body, "text-overflow"), rule.file).toEqual([]);
      expect(declaration(rule.body, "overflow"), rule.file).toEqual([]);
    }
    const base = chips.map((rule) => rule.body).join(";");
    expect(declaration(base, "white-space")).toContain("nowrap");
    expect(declaration(base, "min-width")).toContain("max-content");
    const stats = rulesFor(".atm-project-stats")
      .map((rule) => rule.body)
      .join(";");
    expect(declaration(stats, "flex-wrap")).toContain("wrap");
  });
});

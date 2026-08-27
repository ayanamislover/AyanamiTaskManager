import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function productionSources(): string[] {
  return execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(
      (file) =>
        /^(?:apps|packages)\/[^/]+\/src\/.*\.(?:ts|tsx|html)$/u.test(file) &&
        !file.endsWith(".test.ts") &&
        !file.endsWith(".test.tsx"),
    );
}

function focusRingViolations(css: string): string[] {
  const violations: string[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const selector = match[1]!.trim();
    const body = match[2]!;
    const clearsInnerRing =
      selector.includes(".atm-select-trigger") &&
      /(?:border|outline|box-shadow)\s*:\s*(?:0(?:\s|;|$)|none)/u.test(body);
    const givesShellBorder =
      /(?:^|,)\s*\.atm-select(?:\s|,|$)/u.test(selector) && /\bborder\s*:/u.test(body);
    if ((clearsInnerRing || givesShellBorder) && !selector.includes("field-shell")) {
      violations.push(selector);
    }
  }
  return violations;
}

function selectorsWithoutTransformNone(css: string, selectors: readonly string[]): string[] {
  const covered = new Set<string>();
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const body = match[2]!;
    if (!/\btransform\s*:\s*none\s*;/u.test(body)) continue;
    for (const selector of match[1]!.split(",")) covered.add(selector.trim().replace(/\s+/gu, " "));
  }
  return selectors.filter((selector) => !covered.has(selector));
}

describe("设计系统静态守卫", () => {
  it("生产代码禁止原生 select", () => {
    const offenders = productionSources().filter((file) =>
      /<select(?:\s|>)/u.test(readFileSync(join(root, file), "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("自绘下拉由 field-shell 独占边框和焦点环", () => {
    const css = readFileSync(join(root, "packages", "ui", "src", "styles.css"), "utf8");
    expect(focusRingViolations(css)).toEqual([]);
    expect(css).toMatch(/\.atm-field-shell:has\(> \.atm-select-trigger:focus-visible\)/u);
    expect(css).toMatch(
      /\.atm-field-shell > \.atm-select-trigger:is\(:hover, :focus, :focus-visible\):not\(:disabled\)/u,
    );

    expect(
      focusRingViolations(
        ".atm-select { border: 1px solid red; } .atm-select-trigger { box-shadow: none; }",
      ),
    ).toEqual([".atm-select", ".atm-select-trigger"]);
    expect(
      focusRingViolations(
        ".atm-select.atm-field-shell { border: 1px solid red; } .atm-field-shell > .atm-select-trigger { border: 0; }",
      ),
    ).toEqual([]);
  });

  it("窗口按钮沿用全局按压尺度", () => {
    const css = readFileSync(join(root, "apps", "desktop", "src", "window-chrome.css"), "utf8");
    expect(css).toMatch(/\.atm-window-button:active\s*\{[^}]*transform:\s*scale\(0\.97\)/su);
  });

  it("减少动态覆盖所有按压、展开和排序位移", () => {
    const css = readFileSync(join(root, "packages", "ui", "src", "styles.css"), "utf8");
    const start = css.indexOf("@media (prefers-reduced-motion: reduce)");
    const end = css.indexOf("@media (prefers-reduced-transparency: reduce)", start);
    const reducedMotion = css.slice(start, end);
    const movingSelectors = [
      ".atm-nav button:active",
      ".atm-nav-disclosure:active",
      ".atm-sidebar-settings:active",
      '.atm-nav-disclosure[aria-expanded="true"] svg',
      ".atm-button:active",
      ".atm-project:hover",
      ".atm-notification-option:active",
      ".atm-engineering.is-collapsed .atm-engineering-toggle > svg",
      ".atm-select-trigger:active",
      '.atm-select[data-open="true"] .atm-select-trigger > svg',
      ".atm-select-popover",
      ".atm-table-sort > svg",
      '.atm-table-sort[data-active="true"][data-direction="asc"] > svg',
      ".atm-modal:not(.atm-command)",
      ".atm-drawer",
      ".atm-drawer-collapse:active > svg",
      ".atm-notice",
    ];

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(selectorsWithoutTransformNone(reducedMotion, movingSelectors)).toEqual([]);
    expect(selectorsWithoutTransformNone(".moves { transform: scale(.9); }", [".moves"])).toEqual([
      ".moves",
    ]);
  });

  it("常驻箭头使用对称 easing 且动效时长全部来自 token", () => {
    const css = readFileSync(join(root, "packages", "ui", "src", "styles.css"), "utf8");
    const morphRules = [
      /\.atm-nav-disclosure svg\s*\{[^}]*transition:\s*transform var\(--atm-duration-hover\) var\(--atm-ease-in-out\)/su,
      /\.atm-engineering-toggle > svg\s*\{[^}]*transition:\s*transform var\(--atm-duration-hover\) var\(--atm-ease-in-out\)/su,
      /\.atm-select-trigger > svg\s*\{[^}]*transition:\s*transform var\(--atm-duration-hover\) var\(--atm-ease-in-out\)/su,
      /\.atm-table-sort > svg\s*\{[^}]*transform var\(--atm-duration-hover\) var\(--atm-ease-in-out\)/su,
    ];

    expect(morphRules.filter((rule) => !rule.test(css))).toEqual([]);
    expect(css).not.toMatch(/\b160ms\b/u);
  });
});

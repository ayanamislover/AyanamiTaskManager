import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  productionCssText,
  productionFiles,
  uiComponentCssText,
  uiCssText,
} from "../../../packages/ui/test/css-source-graph.js";

const root = process.cwd();

function productionSources(): string[] {
  return [".ts", ".tsx", ".html"].flatMap((extension) => productionFiles(extension));
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

function ruleBodies(css: string, selector: string): string[] {
  const bodies: string[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const selectors = match[1]!
      .split(",")
      .map((candidate) => candidate.trim().replace(/\s+/gu, " "));
    if (selectors.includes(selector)) bodies.push(match[2]!);
  }
  return bodies;
}

function highFrequencyMotionViolations(css: string): string[] {
  const violations: string[] = [];
  for (const selector of [".atm-nav button", ".atm-sidebar-settings"]) {
    if (ruleBodies(css, selector).some((body) => /\btransition\s*:/u.test(body))) {
      violations.push(`${selector}:transition`);
    }
  }
  for (const selector of [".atm-nav button:active", ".atm-sidebar-settings:active"]) {
    if (ruleBodies(css, selector).some((body) => /\btransform\s*:/u.test(body))) {
      violations.push(`${selector}:transform`);
    }
  }
  if (
    ruleBodies(css, ".atm-project").some((body) => /\btransition\s*:[^;]*\btransform\b/u.test(body))
  ) {
    violations.push(".atm-project:transform-transition");
  }
  if (ruleBodies(css, ".atm-project:hover").some((body) => /\btransform\s*:/u.test(body))) {
    violations.push(".atm-project:hover:transform");
  }
  return violations;
}

function hoverEasingViolations(css: string): string[] {
  return [
    ...css.matchAll(
      /(color|background-color|border-color)\s+var\(--atm-duration-hover\)\s+([^,;\n]+)/gu,
    ),
  ]
    .filter((match) => match[2]!.trim() !== "var(--atm-ease-hover)")
    .map((match) => match[0]);
}

describe("设计系统静态守卫", () => {
  it("生产代码禁止原生 select", () => {
    const offenders = productionSources().filter((file) =>
      /<select(?:\s|>)/u.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);

    const realTsx = productionFiles(".tsx").find((file) =>
      readFileSync(file, "utf8").includes("<AtmSelect"),
    )!;
    const mutated = readFileSync(realTsx, "utf8").replace("<AtmSelect", "<select");
    expect(/<select(?:\s|>)/u.test(mutated)).toBe(true);
    expect(/<select(?:\s|>)/u.test("export const Bad = () => <select />;")).toBe(true);
  });

  it("自绘下拉由 field-shell 独占边框和焦点环", () => {
    const css = uiCssText();
    expect(focusRingViolations(productionCssText())).toEqual([]);
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

    const mutated = css
      .replace(".atm-select.atm-field-shell {", ".atm-select {")
      .replace(".atm-field-shell > .atm-select-trigger {", ".atm-select-trigger {");
    expect(focusRingViolations(mutated)).toEqual(
      expect.arrayContaining([".atm-select", ".atm-select-trigger"]),
    );
  });

  it("窗口按钮沿用全局按压尺度", () => {
    const css = readFileSync(join(root, "apps", "desktop", "src", "window-chrome.css"), "utf8");
    expect(css).toMatch(/\.atm-window-button:active\s*\{[^}]*transform:\s*scale\(0\.97\)/su);
    expect(css).toMatch(
      /\.atm-window-button\s*\{[^}]*transform var\(--atm-duration-press\) var\(--atm-ease-out\)/su,
    );
  });

  it("高频核心导航与项目卡不做无语义缩放或位移", () => {
    const css = uiComponentCssText();
    expect(highFrequencyMotionViolations(css)).toEqual([]);

    const mutated = css
      .replace(
        ".atm-nav button,",
        ".atm-nav button { transition: transform var(--atm-duration-press) var(--atm-ease-out); }\n.atm-nav button,",
      )
      .replace(".atm-project {", ".atm-project { transition: transform 160ms ease;")
      .replace(".atm-project:hover {", ".atm-project:hover { transform: translateY(-1px);");
    expect(highFrequencyMotionViolations(mutated)).toEqual(
      expect.arrayContaining([
        ".atm-nav button:transition",
        ".atm-project:transform-transition",
        ".atm-project:hover:transform",
      ]),
    );
    expect(
      highFrequencyMotionViolations(
        ".atm-sidebar-settings { transition: transform 120ms ease-out; } .atm-sidebar-settings:active { transform: scale(.97); }",
      ),
    ).toEqual([".atm-sidebar-settings:transition", ".atm-sidebar-settings:active:transform"]);
  });

  it("hover 色彩、窗口 chrome 与 drawer backdrop 统一使用批准 token", () => {
    const componentCss = uiComponentCssText();
    const windowChrome = readFileSync(
      join(root, "apps", "desktop", "src", "window-chrome.css"),
      "utf8",
    );
    const tokens = readFileSync(join(root, "packages", "ui", "src", "tokens.css"), "utf8");
    const css = `${componentCss}\n${windowChrome}`;
    const coupledDrawerDuration =
      /\.atm-drawer-backdrop\s*\{[^}]*transition:\s*opacity var\(--atm-duration-surface\) var\(--atm-ease-out\)[^}]*\}[\s\S]*\.atm-drawer\s*\{[^}]*transition:\s*transform var\(--atm-duration-surface\) var\(--atm-ease-drawer\)/su;

    expect(tokens).toContain("--atm-ease-hover: ease;");
    expect(hoverEasingViolations(css)).toEqual([]);
    expect(componentCss).toMatch(coupledDrawerDuration);
    expect(componentCss).not.toMatch(/\b180ms\b/u);

    const mutatedEasing = css.replace("var(--atm-ease-hover)", "var(--atm-ease-out)");
    expect(hoverEasingViolations(mutatedEasing).length).toBeGreaterThan(0);
    const drawerBackdropBody = ruleBodies(componentCss, ".atm-drawer-backdrop").find((body) =>
      body.includes("transition:"),
    );
    expect(drawerBackdropBody).toBeDefined();
    const mutatedDrawer = componentCss.replace(
      drawerBackdropBody!,
      drawerBackdropBody!.replace("var(--atm-duration-surface)", "180ms"),
    );
    expect(mutatedDrawer).not.toMatch(coupledDrawerDuration);
    expect(mutatedDrawer).toMatch(/\b180ms\b/u);
    expect(
      hoverEasingViolations(
        ".bad { transition: color var(--atm-duration-hover) var(--atm-ease-out); }",
      ),
    ).toEqual(["color var(--atm-duration-hover) var(--atm-ease-out)"]);
  });

  it("减少动态覆盖所有按压、展开和排序位移", () => {
    const css = uiCssText();
    const start = css.indexOf("@media (prefers-reduced-motion: reduce)");
    const end = css.indexOf("@media (prefers-reduced-transparency: reduce)", start);
    const reducedMotion = css.slice(start, end);
    const movingSelectors = [
      ".atm-nav-disclosure:active",
      '.atm-nav-disclosure[aria-expanded="true"] svg',
      ".atm-button:active",
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
    for (const obsolete of [
      ".atm-nav button:active",
      ".atm-sidebar-settings:active",
      ".atm-project:hover",
    ]) {
      expect(reducedMotion).not.toContain(obsolete);
    }
    expect(selectorsWithoutTransformNone(reducedMotion, movingSelectors)).toEqual([]);
    expect(
      selectorsWithoutTransformNone(
        reducedMotion.replace("transform: none;", "transform: scale(1);"),
        movingSelectors,
      ).length,
    ).toBeGreaterThan(0);
    expect(selectorsWithoutTransformNone(".moves { transform: scale(.9); }", [".moves"])).toEqual([
      ".moves",
    ]);
  });

  it("常驻箭头使用对称 easing 且动效时长全部来自 token", () => {
    const css = uiComponentCssText();
    const morphRules = [
      /\.atm-nav-disclosure svg\s*\{[^}]*transition:\s*transform var\(--atm-duration-hover\) var\(--atm-ease-in-out\)/su,
      /\.atm-engineering-toggle > svg\s*\{[^}]*transition:\s*transform var\(--atm-duration-hover\) var\(--atm-ease-in-out\)/su,
      /\.atm-select-trigger > svg\s*\{[^}]*transition:\s*transform var\(--atm-duration-hover\) var\(--atm-ease-in-out\)/su,
      /\.atm-table-sort > svg\s*\{[^}]*transform var\(--atm-duration-hover\) var\(--atm-ease-in-out\)/su,
    ];

    expect(morphRules.filter((rule) => !rule.test(css))).toEqual([]);
    expect(css).not.toMatch(/\b160ms\b/u);
    const mutated = css.replace("var(--atm-duration-hover)", "160ms");
    expect(mutated).toMatch(/\b160ms\b/u);
  });
});

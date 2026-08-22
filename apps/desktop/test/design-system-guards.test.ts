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
});

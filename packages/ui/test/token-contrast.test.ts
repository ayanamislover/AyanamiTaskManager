import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 浅色主题里当文字用的 token，在白卡与画布上都要 ≥ 4.5:1（WCAG AA 正文）。
// 柔彩风格容易把辅助字调得太淡：0515 定稿时 faint 只有 3:1、橙色状态字只有 2.5:1。

const tokens = readFileSync(join(process.cwd(), "packages", "ui", "src", "tokens.css"), "utf8");
const lightBlock = tokens.slice(tokens.indexOf(":root {"), tokens.indexOf(":root[data-theme"));

function token(name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})\\s*;`, "iu").exec(lightBlock);
  if (!match) throw new Error(`浅色主题里找不到 --${name}`);
  return match[1]!;
}

const channels = (hex: string) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe("浅色主题文字对比度", () => {
  it("辅助文字与语义色在白卡和画布上都 ≥ 4.5:1", () => {
    const backgrounds = [token("atm-surface"), token("atm-bg")];
    const textTokens = [
      "atm-text",
      "atm-text-muted",
      "atm-text-faint",
      "atm-success",
      "atm-warning",
      "atm-danger",
      "atm-info",
      "atm-control-text",
    ];
    const failures = textTokens.flatMap((name) =>
      backgrounds
        .map((background) => ({ name, background, ratio: contrast(token(name), background) }))
        .filter((each) => each.ratio < 4.5),
    );
    expect(failures).toEqual([]);
  });

  it("阳性对照：旧的 faint 取值确实会被判不合格", () => {
    expect(contrast("#9a8fb0", "#ffffff")).toBeLessThan(4.5);
    expect(contrast("#3b2f55", "#ffffff")).toBeGreaterThan(4.5);
  });
});

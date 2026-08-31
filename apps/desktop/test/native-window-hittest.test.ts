import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "scripts", "native-window-hittest.ps1"), "utf8");

describe("Windows 原生窗口命中探针", () => {
  it("直接使用 Playwright 的逻辑客户区坐标，避免在缩放屏幕上重复乘 DPI", () => {
    expect(source).not.toContain("GetDpiForWindow");
    expect(source).toContain("Math.Round(clientX)");
    expect(source).toContain("Math.Round(clientY)");
    expect(source).not.toMatch(/client[XY]\s*\*\s*scale/u);
  });
});

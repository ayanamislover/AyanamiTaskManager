import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cssPointToScreen } from "../../../scripts/native-window.js";

const source = readFileSync(join(process.cwd(), "scripts", "native-window.ps1"), "utf8");

describe("Windows 原生窗口命中探针", () => {
  it("CSS 像素换屏幕物理像素只乘一次 devicePixelRatio", () => {
    expect(cssPointToScreen({ x: 100, y: 50 }, { x: 10, y: 20 }, 1)).toEqual({ x: 110, y: 70 });
    // 150% 缩放：客户区原点已是物理像素，CSS 坐标乘 1.5，再乘一次就探错元素。
    expect(cssPointToScreen({ x: 100, y: 50 }, { x: 10, y: 20 }, 1.5)).toEqual({ x: 115, y: 80 });
  });

  it("探针线程是 Per-Monitor-V2，不再靠系统虚拟化坐标", () => {
    expect(source).toContain("SetThreadDpiAwarenessContext(new IntPtr(-4))");
    // 坐标换算只在调用方做一次：探针里不能再按窗口 DPI 乘一遍。
    expect(source).not.toMatch(/\*\s*GetDpiForWindow|GetDpiForWindow\([^)]*\)\s*\*/u);
  });

  it("命中测试沿 Z 序走到最深的子窗口，HTTRANSPARENT 交给下一个兄弟", () => {
    // WebView2 的 app-region 由它自己建的拖拽子窗口回 HTCAPTION；只问宿主顶层窗口永远是 HTCLIENT。
    expect(source).toContain("GetWindow(current, GW_CHILD)");
    expect(source).toContain("GetWindow(child, GW_HWNDNEXT)");
    expect(source).toMatch(/if \(answer == HTTRANSPARENT\) continue;/u);
    // 不用 WindowFromPoint：它要求应用窗口在 Z 序最上面。
    expect(source).not.toMatch(/WindowFromPoint\(/u);
  });

  it("Electron 时代只问顶层窗口的旧探针已经移除", () => {
    expect(existsSync(join(process.cwd(), "scripts", "native-window-hittest.ps1"))).toBe(false);
  });
});

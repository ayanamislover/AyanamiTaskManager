import { describe, expect, it } from "vitest";
import { createWindowOptions } from "../src/window-options.js";

describe("createWindowOptions", () => {
  it("创建可操作的无边框桌面窗口", () => {
    const options = createWindowOptions("C:\\atm\\preload.cjs", false, "C:\\atm\\logo.png");

    expect(options).toMatchObject({
      width: 1920,
      height: 1080,
      frame: false,
      resizable: true,
      minimizable: true,
      maximizable: true,
      closable: true,
      backgroundColor: "#F7F5F0",
      icon: "C:\\atm\\logo.png",
      webPreferences: {
        preload: "C:\\atm\\preload.cjs",
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
  });

  it("按原生系统主题选择暗色首屏背景", () => {
    expect(createWindowOptions("preload.cjs", true).backgroundColor).toBe("#1F1D23");
  });
});

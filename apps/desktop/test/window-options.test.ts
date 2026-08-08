import { describe, expect, it } from "vitest";
import { createWindowOptions } from "../src/window-options.js";

describe("createWindowOptions", () => {
  it("创建可操作的无边框桌面窗口", () => {
    const options = createWindowOptions("C:\\atm\\preload.cjs", false);

    expect(options).toMatchObject({
      frame: false,
      resizable: true,
      minimizable: true,
      maximizable: true,
      closable: true,
      backgroundColor: "#F7F5F0",
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

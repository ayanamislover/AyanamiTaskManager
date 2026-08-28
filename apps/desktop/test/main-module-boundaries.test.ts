import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = join(process.cwd(), "apps", "desktop", "src");
const modules = [
  "main.ts",
  "main-agent-integrations.ts",
  "runtime-host.ts",
  "update-host.ts",
  "window-host.ts",
];

function source(name: string): string {
  return readFileSync(join(sourceRoot, name), "utf8");
}

describe("Electron main process module boundaries", () => {
  it("keeps main and extracted business modules within the 600-line budget", () => {
    expect(modules.length).toBeGreaterThan(1);
    for (const module of modules) {
      const lines = source(module).split(/\r?\n/u).length;
      expect(lines, `${module} has ${lines} lines`).toBeLessThanOrEqual(600);
    }
  });

  it("keeps main as lifecycle composition instead of owning browser and integration details", () => {
    const entry = source("main.ts");
    expect(entry).toContain("startRuntimeHost()");
    expect(entry).toContain("installAgentIntegrationHost");
    expect(entry).toContain("new WindowHost");
    expect(entry).toContain("new UpdateHost");
    expect(entry).toContain("requestSingleInstanceLock()");
    expect(entry).not.toMatch(/\bBrowserWindow\b|\bnew Tray\b/u);
    expect(entry).not.toContain("@ayanami-task/agent-config");
    expect(entry).not.toContain("buildAyanamiServer");
  });

  it("preserves security, close-to-background, tray, autostart and preload IPC contracts", () => {
    const runtime = source("runtime-host.ts");
    const update = source("update-host.ts");
    const window = source("window-host.ts");
    expect(runtime).toContain('server.listen({ host: "127.0.0.1", port: 0 })');
    expect(runtime).toContain('flag: "wx"');
    expect(runtime).toContain("rmSync(runtimePath, { force: true })");
    expect(window).toContain("event.preventDefault()");
    expect(window).toContain("this.mainWindow?.hide()");
    expect(window).toContain('ipcMain.handle("atm:window-close"');
    expect(window).toContain('label: "完全退出"');
    expect(runtime).toContain("app.getLoginItemSettings");
    expect(runtime).toContain("app.setLoginItemSettings");
    expect(runtime).toContain('ipcMain.on("atm:get-runtime"');
    expect(update).toContain('ipcMain.handle("atm:get-update-status"');
    expect(update).toContain('autoUpdater.on("update-downloaded"');
  });
});

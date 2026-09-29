import type { BrowserWindowConstructorOptions } from "electron";

const LIGHT_WINDOW_BACKGROUND = "#FBF7FF";
const DARK_WINDOW_BACKGROUND = "#241E30";

export function createWindowOptions(
  preloadPath: string,
  dark: boolean,
  iconPath?: string,
): BrowserWindowConstructorOptions {
  return {
    width: 1920,
    height: 1080,
    minWidth: 1100,
    minHeight: 680,
    show: false,
    frame: false,
    resizable: true,
    minimizable: true,
    maximizable: true,
    closable: true,
    backgroundColor: dark ? DARK_WINDOW_BACKGROUND : LIGHT_WINDOW_BACKGROUND,
    title: "AyanamiTaskManager",
    ...(iconPath ? { icon: iconPath } : {}),
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
}

import type { BrowserWindowConstructorOptions } from "electron";

const LIGHT_WINDOW_BACKGROUND = "#F7F5F0";
const DARK_WINDOW_BACKGROUND = "#1F1D23";

export function createWindowOptions(
  preloadPath: string,
  dark: boolean,
  iconPath?: string,
): BrowserWindowConstructorOptions {
  return {
    width: 1440,
    height: 900,
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

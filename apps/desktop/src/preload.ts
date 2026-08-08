import { contextBridge, ipcRenderer } from "electron";

const runtime = ipcRenderer.sendSync("atm:get-runtime") as { endpoint: string; token: string };
contextBridge.exposeInMainWorld("ayanamiDesktop", {
  runtime,
  setAutoLaunch: (enabled: boolean) => ipcRenderer.invoke("atm:set-auto-launch", enabled),
  getAutoLaunch: () => ipcRenderer.invoke("atm:get-auto-launch"),
  showItemInFolder: (path: string) => ipcRenderer.invoke("atm:show-item", path),
  getMcpConfigs: () => ipcRenderer.invoke("atm:get-mcp-configs"),
  installMcp: (client: "CODEX" | "CLAUDE") => ipcRenderer.invoke("atm:install-mcp", client),
  copyText: (text: string) => ipcRenderer.invoke("atm:copy-text", text),
  onNavigate: (listener: (route: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, route: string) => listener(route);
    ipcRenderer.on("atm:navigate", handler);
    return () => ipcRenderer.off("atm:navigate", handler);
  },
});

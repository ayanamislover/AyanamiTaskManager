import { contextBridge, ipcRenderer } from "electron";

type McpClient = "CODEX" | "CLAUDE" | "CLAUDE_CODE";

const runtime = ipcRenderer.sendSync("atm:get-runtime") as { endpoint: string; token: string };
contextBridge.exposeInMainWorld("ayanamiDesktop", {
  runtime,
  setAutoLaunch: (enabled: boolean) => ipcRenderer.invoke("atm:set-auto-launch", enabled),
  getAutoLaunch: () => ipcRenderer.invoke("atm:get-auto-launch"),
  getUpdateStatus: () => ipcRenderer.invoke("atm:get-update-status"),
  checkForUpdates: () => ipcRenderer.invoke("atm:check-for-updates"),
  showItemInFolder: (path: string) => ipcRenderer.invoke("atm:show-item", path),
  getMcpConfigs: () => ipcRenderer.invoke("atm:get-mcp-configs"),
  installMcp: (client: McpClient) => ipcRenderer.invoke("atm:install-mcp", client),
  getAgentIntegrations: () => ipcRenderer.invoke("atm:get-agent-integrations"),
  manageAgentIntegration: (
    client: McpClient,
    action: "PREVIEW" | "INSTALL" | "UPDATE" | "REPAIR" | "UNINSTALL",
  ) => ipcRenderer.invoke("atm:manage-agent-integration", client, action),
  copyText: (text: string) => ipcRenderer.invoke("atm:copy-text", text),
  minimizeWindow: () => ipcRenderer.invoke("atm:window-minimize"),
  toggleMaximizeWindow: () => ipcRenderer.invoke("atm:window-toggle-maximize"),
  isWindowMaximized: () => ipcRenderer.invoke("atm:window-is-maximized"),
  closeWindow: () => ipcRenderer.invoke("atm:window-close"),
  onWindowMaximizedChange: (listener: (maximized: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, maximized: boolean) => listener(maximized);
    ipcRenderer.on("atm:window-maximized-changed", handler);
    return () => ipcRenderer.off("atm:window-maximized-changed", handler);
  },
  onNavigate: (listener: (route: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, route: string) => listener(route);
    ipcRenderer.on("atm:navigate", handler);
    return () => ipcRenderer.off("atm:navigate", handler);
  },
});

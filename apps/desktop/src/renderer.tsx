import { CornersInIcon as CornersIn } from "@phosphor-icons/react/dist/icons/CornersIn";
import { MinusIcon as Minus } from "@phosphor-icons/react/dist/icons/Minus";
import { SquareIcon as Square } from "@phosphor-icons/react/dist/icons/Square";
import { XIcon as X } from "@phosphor-icons/react/dist/icons/X";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AyanamiClient } from "@ayanami-task/client";
import { AyanamiTaskManager } from "@ayanami-task/ui";
import brandLogoUrl from "../../../logo.png?url";
import "./window-chrome.css";

type McpClient = "CODEX" | "CLAUDE" | "CLAUDE_CODE";
type McpProfileSwitchResult = {
  enabled: boolean;
  status: "APPLIED";
  restartRequired: boolean;
  clients: Array<{
    client: McpClient;
    target: string;
    status: "SKIPPED" | "UPDATED" | "FAILED" | "ROLLED_BACK" | "ROLLBACK_FAILED";
    error?: string;
  }>;
};
type UpdateStatus = {
  phase: "CHECK" | "DOWNLOAD" | "VERIFY" | "INSTALL" | "READY";
  outcome: "IN_PROGRESS" | "SUCCESS" | "ERROR" | "SKIPPED";
  code: string;
  message: string;
  action: string;
  at: string;
  version: string | null;
};
type McpBridgeObservation = {
  sampledAt: string;
  metric: "PRIVATE_BYTES";
  totalPrivateBytes: number;
  bridges: Array<{
    pid: number;
    ownerPid: number | null;
    ownerName: string;
    startedAt: string;
    privateBytes: number;
  }>;
};

type DesktopBridge = {
  runtimeRequest(input: {
    path: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
  }>;
  setAutoLaunch(enabled: boolean): Promise<boolean>;
  getAutoLaunch(): Promise<boolean>;
  getUpdateStatus(): Promise<UpdateStatus | null>;
  checkForUpdates(): Promise<UpdateStatus | null>;
  showItemInFolder(path: string): Promise<void>;
  getMcpConfigs(): Promise<{
    streamableHttp: string;
    stdio: string;
    generic: string;
    agentRule: string;
  }>;
  getMcpBridges(): Promise<McpBridgeObservation>;
  getMemoryProfile(): Promise<boolean>;
  setMemoryProfile(enabled: boolean): Promise<McpProfileSwitchResult>;
  installMcp(client: McpClient): Promise<{ path: string; backupPath: string | null }>;
  getAgentIntegrations(): Promise<AgentIntegrationReport[]>;
  manageAgentIntegration(
    client: McpClient,
    action: AgentIntegrationAction,
  ): Promise<{ report: AgentIntegrationReport; preview: AgentRulePreview | null }>;
  copyText(text: string): Promise<boolean>;
  minimizeWindow(): Promise<void>;
  toggleMaximizeWindow(): Promise<boolean>;
  isWindowMaximized(): Promise<boolean>;
  closeWindow(): Promise<void>;
  onWindowMaximizedChange(listener: (maximized: boolean) => void): () => void;
  onNavigate(listener: (route: string) => void): () => void;
};

type AgentIntegrationState = "NOT_INSTALLED" | "INSTALLED" | "NEEDS_UPDATE" | "MODIFIED";
type AgentIntegrationAction = "PREVIEW" | "INSTALL" | "UPDATE" | "REPAIR" | "UNINSTALL";
type AgentRulePreview = { current: string; proposed: string };
type AgentIntegrationReport = {
  client: McpClient;
  mcpInstalled: boolean;
  repairError: string | null;
  sharesRuleAndSkillsWith: "CLAUDE" | null;
  cliAvailable: boolean;
  rule: { state: AgentIntegrationState; path: string; version: number | null };
  skills: {
    state: AgentIntegrationState;
    skills: Array<{ name: string; state: AgentIntegrationState; version: number | null }>;
  };
};

declare global {
  interface Window {
    ayanamiDesktop?: DesktopBridge;
  }
}

function DesktopWindowChrome({ desktop }: { desktop: DesktopBridge }) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let mounted = true;
    void desktop.isWindowMaximized().then((value) => {
      if (mounted) setMaximized(value);
    });
    const unsubscribe = desktop.onWindowMaximizedChange(setMaximized);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [desktop]);

  return (
    <div className="atm-window-chrome" role="toolbar" aria-label="窗口控制">
      <button
        className="atm-window-button"
        data-testid="window-minimize"
        type="button"
        aria-label="最小化窗口"
        title="最小化窗口"
        onClick={() => void desktop.minimizeWindow()}
      >
        <Minus size={16} weight="bold" />
      </button>
      <button
        className="atm-window-button"
        data-testid="window-maximize"
        type="button"
        aria-label={maximized ? "还原窗口" : "最大化窗口"}
        title={maximized ? "还原窗口" : "最大化窗口"}
        onClick={() => void desktop.toggleMaximizeWindow().then(setMaximized)}
      >
        {maximized ? <CornersIn size={15} /> : <Square size={14} />}
      </button>
      <button
        className="atm-window-button atm-window-button-close"
        data-testid="window-close"
        type="button"
        aria-label="关闭窗口并保留托盘运行"
        title="关闭窗口并保留托盘运行"
        onClick={() => void desktop.closeWindow()}
      >
        <X size={16} weight="bold" />
      </button>
    </div>
  );
}

const browserEndpoint = import.meta.env.VITE_ATM_ENDPOINT as string | undefined;
const browserToken = import.meta.env.VITE_ATM_TOKEN as string | undefined;
const desktop = window.ayanamiDesktop;
if (desktop) document.documentElement.dataset.atmDesktop = "true";
const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
if (favicon) favicon.href = brandLogoUrl;
const client = desktop
  ? new AyanamiClient({
      endpoint: "http://atm.renderer.invalid",
      token: "ipc-capability",
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        const response = await desktop.runtimeRequest({
          path: `${url.pathname}${url.search}`,
          ...(init?.method ? { method: init.method } : {}),
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          ...(typeof init?.body === "string" ? { body: init.body } : {}),
        });
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      },
    })
  : new AyanamiClient({
      endpoint: browserEndpoint ?? "http://127.0.0.1:43127",
      token: browserToken ?? "browser-preview-token",
    });
const root = document.getElementById("root");
if (!root) throw new Error("ROOT_ELEMENT_MISSING");

createRoot(root).render(
  <StrictMode>
    {desktop ? <DesktopWindowChrome desktop={desktop} /> : null}
    <AyanamiTaskManager
      client={client}
      brandLogoSrc={brandLogoUrl}
      {...(desktop === undefined ? {} : { desktop })}
    />
  </StrictMode>,
);

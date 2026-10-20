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

type McpClient = "CODEX" | "CLAUDE" | "CLAUDE_CODE" | "KIMI_CODE";
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
type DataSourceState =
  | {
      state: "SOURCE_CONFLICT";
      cause: "CHANGED" | "UNREADABLE" | "LEGACY_GONE" | "OTHER_SOURCE" | "RECORD";
      reason: string;
      since: string;
      error: string | null;
    }
  | { state: "STARTING"; choosing: boolean; error?: string | null }
  | { state: "SERVING" | "UNAVAILABLE"; choosing: false; error: string | null }
  | {
      /** 已发布的库读不出（W8f-3）：不服务、不动文件，等用户退出后运行 `command`（atm.exe 的完整路径）。 */
      state: "DAMAGED";
      generation: string;
      reason: string;
      command: string;
      dataDir: string;
      backups: Array<{
        id: string;
        kind: string;
        createdAt: string;
        status: "USABLE" | "UNUSABLE";
        problem: string | null;
      }> | null;
      backupsError: string | null;
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
  notifyRendererReady(): void;
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
  applyUpdate(): Promise<UpdateStatus | null>;
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
  /** 可选：老宿主与 e2e 的桩没有它，没有就当系统外框（不渲染缩放把手）。 */
  getWindowFrame?(): Promise<WindowFrame>;
  startWindowResize?(edge: WindowEdge): Promise<boolean>;
  onWindowMaximizedChange(listener: (maximized: boolean) => void): () => void;
  onNavigate(listener: (route: string) => void): () => void;
  getDataSource(): Promise<DataSourceState>;
  chooseDataSource(choice: "KEEP_V3" | "RECONVERT"): Promise<DataSourceState>;
  onDataSourceChange(listener: (state: DataSourceState) => void): () => void;
};

/** 窗口外框归谁画：系统（缩放边在外框里），或界面（Windows 10：贴边的把手发起缩放，见 frame.rs）。 */
type WindowFrame = "native" | "client";
const windowEdges = [
  "left",
  "right",
  "bottom",
  "bottomLeft",
  "bottomRight",
  "topLeft",
  "topRight",
] as const;
type WindowEdge = (typeof windowEdges)[number];

function RendererReadySignal({ desktop }: { desktop: DesktopBridge }) {
  useEffect(() => {
    // 不能用 requestAnimationFrame 等：窗口是 show:false 建的，backgroundThrottling
    // 默认开着，隐藏页面的帧回调不保证被派发——而这里恰恰是要在窗口还隐藏时报到。
    // effect 在整棵树 commit 之后才跑，所以直接查一次通常就命中；剩下的交给
    // MutationObserver，它按 DOM 变更触发，不依赖帧也不受节流影响。
    const announceWhenMounted = () => {
      if (!document.querySelector(".atm-shell")) return false;
      desktop.notifyRendererReady();
      return true;
    };
    if (announceWhenMounted()) return;
    const observer = new MutationObserver(() => {
      if (announceWhenMounted()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [desktop]);
  return null;
}

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

function useWindowMaximized(desktop: DesktopBridge) {
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

  return [maximized, setMaximized] as const;
}

/**
 * Windows 10 的缩放把手：窗口没有系统的缩放边（那会让 DWM 画一圈边框线），贴边的几条把手接住
 * 按下，交给宿主走系统的缩放循环。最大化时不渲染。必须排在整个界面后面：WebView2 按文档顺序判
 * 拖动区，排在前面会被外壳的拖动区盖掉（window-chrome.css）。
 */
function DesktopWindowEdges({ desktop }: { desktop: DesktopBridge }) {
  const [maximized] = useWindowMaximized(desktop);
  const [frame, setFrame] = useState<WindowFrame>("native");

  useEffect(() => {
    let mounted = true;
    void desktop
      .getWindowFrame?.()
      .then((value) => {
        if (mounted) setFrame(value);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, [desktop]);

  if (frame !== "client" || maximized || !desktop.startWindowResize) return null;
  const startResize = desktop.startWindowResize.bind(desktop);
  return (
    <div className="atm-window-edges" aria-hidden="true">
      {windowEdges.map((edge) => (
        <div
          key={edge}
          className="atm-window-edge"
          data-edge={edge}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            void startResize(edge);
          }}
        />
      ))}
    </div>
  );
}

function DesktopWindowChrome({ desktop }: { desktop: DesktopBridge }) {
  const [maximized, setMaximized] = useWindowMaximized(desktop);

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

function missingDesktopBridge(): never {
  throw new Error("ATM_DESKTOP_BRIDGE_MISSING");
}

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
  : // 生产包只在宿主 WebView 里跑：没有桥就是被别处加载了，不去连任何端口。
    // 浏览器直连只留给 vite dev server（e2e、README 截图）；DEV 是构建期常量，
    // 生产构建里这一支连同其中的端口和预览 token 一起被消除。
    import.meta.env.DEV
    ? new AyanamiClient({
        endpoint:
          (import.meta.env.VITE_ATM_ENDPOINT as string | undefined) ?? "http://127.0.0.1:43127",
        token: (import.meta.env.VITE_ATM_TOKEN as string | undefined) ?? "browser-preview-token",
      })
    : missingDesktopBridge();
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
    {desktop ? <DesktopWindowEdges desktop={desktop} /> : null}
    {desktop ? <RendererReadySignal desktop={desktop} /> : null}
  </StrictMode>,
);

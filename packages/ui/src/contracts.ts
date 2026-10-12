import type {
  AyanamiClient,
  RegisteredProject as ClientRegisteredProject,
} from "@ayanami-task/client";

export type SidebarProject = Pick<ClientRegisteredProject, "id" | "code" | "name" | "lifecycle">;

export type Route =
  | "overview"
  | "projects"
  | "my"
  | "quick"
  | "blockers"
  | "agents"
  | "timeline"
  | "knowledge"
  | "settings"
  | `project:${string}`;

export type Notify = (message: string) => void;
export type Theme = "light" | "dark";
export type NotificationMode = "ALL" | "CRITICAL" | "OFF";
export type AgentIntegrationState = "NOT_INSTALLED" | "INSTALLED" | "NEEDS_UPDATE" | "MODIFIED";
export type AgentIntegrationAction = "PREVIEW" | "INSTALL" | "UPDATE" | "REPAIR" | "UNINSTALL";
export type McpClient = "CODEX" | "CLAUDE" | "CLAUDE_CODE" | "KIMI_CODE";

export type McpProfileSwitchResult = {
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

export type UpdateStatus = {
  phase: "CHECK" | "DOWNLOAD" | "VERIFY" | "INSTALL" | "READY";
  outcome: "IN_PROGRESS" | "SUCCESS" | "ERROR" | "SKIPPED";
  code: string;
  message: string;
  action: string;
  at: string;
  version: string | null;
};

export type AgentIntegrationReport = {
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

export type McpBridgeObservation = {
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

/** 数据源冲突的原因归类（宿主按运行时的原因原文归的类，07 §7）。 */
export type DataSourceConflictCause =
  | "CHANGED"
  | "UNREADABLE"
  | "LEGACY_GONE"
  | "OTHER_SOURCE"
  | "RECORD";

export type DataSourceChoice = "KEEP_V3" | "RECONVERT";

/** 宿主里服务走到了哪一步。`error` 是上一次选择没能做成的原因。 */
export type DataSourceState =
  | {
      state: "SOURCE_CONFLICT";
      cause: DataSourceConflictCause;
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
    };

export type DesktopBridge = {
  setAutoLaunch?: (enabled: boolean) => Promise<boolean>;
  getAutoLaunch?: () => Promise<boolean>;
  getUpdateStatus?: () => Promise<UpdateStatus | null>;
  checkForUpdates?: () => Promise<UpdateStatus | null>;
  /** 安装已就绪的本地更新：应用会关闭，装好后带窗口重新打开。 */
  applyUpdate?: () => Promise<UpdateStatus | null>;
  getMcpConfigs?: () => Promise<{
    streamableHttp: string;
    stdio: string;
    generic: string;
    agentRule: string;
  }>;
  getMcpBridges?: () => Promise<McpBridgeObservation>;
  getMemoryProfile?: () => Promise<boolean>;
  setMemoryProfile?: (enabled: boolean) => Promise<McpProfileSwitchResult>;
  installMcp?: (client: McpClient) => Promise<{ path: string; backupPath: string | null }>;
  getAgentIntegrations?: () => Promise<AgentIntegrationReport[]>;
  manageAgentIntegration?: (
    client: McpClient,
    action: AgentIntegrationAction,
  ) => Promise<{
    report: AgentIntegrationReport;
    preview: { current: string; proposed: string } | null;
  }>;
  copyText?: (text: string) => Promise<boolean>;
  onNavigate?: (listener: (route: string) => void) => () => void;
  getDataSource?: () => Promise<DataSourceState>;
  /** 只有桌面窗口里的用户能选（07 §7）；返回选择之后的状态。 */
  chooseDataSource?: (choice: DataSourceChoice) => Promise<DataSourceState>;
  onDataSourceChange?: (listener: (state: DataSourceState) => void) => () => void;
};

export type AyanamiTaskManagerProps = {
  client: AyanamiClient;
  desktop?: DesktopBridge;
  brandLogoSrc?: string;
};

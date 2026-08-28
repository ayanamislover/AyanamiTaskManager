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
  | "settings"
  | `project:${string}`;

export type Notify = (message: string) => void;
export type Theme = "light" | "dark";
export type NotificationMode = "ALL" | "CRITICAL" | "OFF";
export type AgentIntegrationState = "NOT_INSTALLED" | "INSTALLED" | "NEEDS_UPDATE" | "MODIFIED";
export type AgentIntegrationAction = "PREVIEW" | "INSTALL" | "UPDATE" | "REPAIR" | "UNINSTALL";
export type McpClient = "CODEX" | "CLAUDE" | "CLAUDE_CODE";

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

export type DesktopBridge = {
  runtime?: { endpoint: string; token: string };
  setAutoLaunch?: (enabled: boolean) => Promise<boolean>;
  getAutoLaunch?: () => Promise<boolean>;
  getUpdateStatus?: () => Promise<UpdateStatus | null>;
  checkForUpdates?: () => Promise<UpdateStatus | null>;
  showItemInFolder?: (path: string) => Promise<void>;
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
};

export type AyanamiTaskManagerProps = {
  client: AyanamiClient;
  desktop?: DesktopBridge;
  brandLogoSrc?: string;
};

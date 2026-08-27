import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  QueryClientProvider,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ArchiveIcon as Archive } from "@phosphor-icons/react/dist/icons/Archive";
import { ArrowCounterClockwiseIcon as ArrowCounterClockwise } from "@phosphor-icons/react/dist/icons/ArrowCounterClockwise";
import { ArrowRightIcon as ArrowRight } from "@phosphor-icons/react/dist/icons/ArrowRight";
import { CaretDownIcon as CaretDown } from "@phosphor-icons/react/dist/icons/CaretDown";
import { CaretRightIcon as CaretRight } from "@phosphor-icons/react/dist/icons/CaretRight";
import { CheckCircleIcon as CheckCircle } from "@phosphor-icons/react/dist/icons/CheckCircle";
import { CheckSquareIcon as CheckSquare } from "@phosphor-icons/react/dist/icons/CheckSquare";
import { ClockCounterClockwiseIcon as ClockCounterClockwise } from "@phosphor-icons/react/dist/icons/ClockCounterClockwise";
import { FolderOpenIcon as FolderOpen } from "@phosphor-icons/react/dist/icons/FolderOpen";
import { GearSixIcon as GearSix } from "@phosphor-icons/react/dist/icons/GearSix";
import { GitBranchIcon as GitBranch } from "@phosphor-icons/react/dist/icons/GitBranch";
import { HouseIcon as House } from "@phosphor-icons/react/dist/icons/House";
import { KanbanIcon as Kanban } from "@phosphor-icons/react/dist/icons/Kanban";
import { LightningIcon as Lightning } from "@phosphor-icons/react/dist/icons/Lightning";
import { ListBulletsIcon as ListBullets } from "@phosphor-icons/react/dist/icons/ListBullets";
import { MagnifyingGlassIcon as MagnifyingGlass } from "@phosphor-icons/react/dist/icons/MagnifyingGlass";
import { MoonIcon as Moon } from "@phosphor-icons/react/dist/icons/Moon";
import { PlayIcon as Play } from "@phosphor-icons/react/dist/icons/Play";
import { PlusIcon as Plus } from "@phosphor-icons/react/dist/icons/Plus";
import { RowsIcon as Rows } from "@phosphor-icons/react/dist/icons/Rows";
import { SunIcon as Sun } from "@phosphor-icons/react/dist/icons/Sun";
import { UsersThreeIcon as UsersThree } from "@phosphor-icons/react/dist/icons/UsersThree";
import { WarningCircleIcon as WarningCircle } from "@phosphor-icons/react/dist/icons/WarningCircle";
import { XIcon as X } from "@phosphor-icons/react/dist/icons/X";
import {
  AyanamiClient,
  type RegisteredProject,
  type UserRecordCreateInput,
} from "@ayanami-task/client";
import {
  findAgentSessionConflicts,
  groupAgentSessions,
  type AgentSessionLike,
} from "./agent-sessions.js";
import { checklistToggleIntent, evidenceText } from "./checklist-evidence.js";
import { EngineeringMetricsPanel } from "./project-statistics-panel.js";
import { McpBridgePanel, type McpBridgeObservation } from "./mcp-bridge-panel.js";
import { createAyanamiQueryClient } from "./query-policy.js";
import { recordDraftToUserInput } from "./record-input.js";
import {
  formatReconciliationAge,
  reconciliationLabel,
  reconciliationSummary,
} from "./reconciliation.js";
import { presentTimelineEvent } from "./timeline-events.js";
import { taskProgressPresentation } from "./task-progress.js";
import {
  sortProjectTasks,
  toggleProjectTaskSort,
  type ProjectTaskSort,
  type ProjectTaskSortField,
} from "./task-sort.js";
import "./styles.css";

type Route =
  | "overview"
  | "projects"
  | "my"
  | "quick"
  | "blockers"
  | "agents"
  | "timeline"
  | "settings"
  | `project:${string}`;
type Notify = (message: string) => void;
type Theme = "light" | "dark";
type NotificationMode = "ALL" | "CRITICAL" | "OFF";
type AgentIntegrationState = "NOT_INSTALLED" | "INSTALLED" | "NEEDS_UPDATE" | "MODIFIED";
type AgentIntegrationAction = "PREVIEW" | "INSTALL" | "UPDATE" | "REPAIR" | "UNINSTALL";
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
type DesktopBridge = {
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

const themeStorageKey = "atm.theme";

function readStoredTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(themeStorageKey);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function readSystemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function persistTheme(theme: Theme) {
  try {
    window.localStorage.setItem(themeStorageKey, theme);
  } catch {
    // 本地存储不可用时仍保留当前窗口的主题切换能力。
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
    Boolean(target.closest('[contenteditable="true"]'))
  );
}

const statusLabels: Record<string, string> = {
  BACKLOG: "待整理",
  READY: "可开始",
  CLAIMED: "已领取",
  IN_PROGRESS: "进行中",
  BLOCKED: "已阻塞",
  WAITING_USER: "等待用户",
  WAITING_AGENT: "等待 Agent",
  VERIFYING: "验收中",
  DONE: "已完成",
  CANCELLED: "已取消",
  OPEN: "待处理",
  PROMOTED: "已晋升",
  ARCHIVED: "已归档",
  TRASHED: "垃圾箱",
  ACTIVE: "活动",
  ON_TRACK: "正常",
  AT_RISK: "有风险",
  OFF_TRACK: "偏离计划",
  UNKNOWN: "未知",
  ONLINE: "在线",
  CLOSED: "已关闭",
  PRIMARY: "主 Agent",
  SUBAGENT: "子 Agent",
  REVIEWER: "审阅者",
  OBSERVER: "观察者",
  SOLO: "单 Agent",
  AUTO: "自动判断",
  MULTI: "多 Agent",
};

const priorityLabels: Record<string, string> = {
  LOW: "低",
  NORMAL: "普通",
  HIGH: "高",
  CRITICAL: "紧急",
};
const progressSourceLabels: Record<string, string> = {
  NONE: "尚无进度",
  CHECKLIST: "检查项计算",
  CHILDREN: "子任务汇总",
  REPORTED: "人工报告",
  STATUS: "状态计算",
};
function statusClass(status: string): string {
  if (["DONE", "ACTIVE", "ON_TRACK"].includes(status)) return "success";
  if (["BLOCKED", "OFF_TRACK", "MIGRATION_FAILED"].includes(status)) return "danger";
  if (["WAITING_USER", "WAITING_AGENT", "AT_RISK"].includes(status)) return "warning";
  if (["IN_PROGRESS", "CLAIMED", "READY", "VERIFYING"].includes(status)) return "primary";
  return "";
}

function Status({ value }: { value: string }) {
  return <span className={`atm-badge ${statusClass(value)}`}>{statusLabels[value] ?? value}</span>;
}

type AtmSelectOption = { value: string; label: string };

function AtmSelect({
  id,
  ariaLabel,
  value,
  options,
  onChange,
  className = "",
}: {
  id?: string;
  ariaLabel: string;
  value: string;
  options: AtmSelectOption[];
  onChange: (value: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<"top" | "bottom">("bottom");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const openingIndexRef = useRef(0);
  const listboxId = `atm-select-${useId().replaceAll(":", "")}`;
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const selectedLabel = options[selectedIndex]?.label ?? options[0]?.label ?? "未选择";

  const openAt = (index: number) => {
    openingIndexRef.current = Math.max(0, Math.min(index, options.length - 1));
    const root = rootRef.current;
    if (root) {
      const bounds = root.getBoundingClientRect();
      const boundary = root.closest(".atm-modal, .atm-drawer")?.getBoundingClientRect();
      const desired = Math.min(320, options.length * 34 + 12);
      const spaceBelow = (boundary?.bottom ?? window.innerHeight) - bounds.bottom - 12;
      const spaceAbove = bounds.top - (boundary?.top ?? 0) - 12;
      setPlacement(spaceBelow < desired && spaceAbove > spaceBelow ? "top" : "bottom");
    }
    setOpen(true);
  };
  const closeAndFocusTrigger = () => {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    closeAndFocusTrigger();
  };
  const focusOption = (index: number) => {
    const next = (index + options.length) % options.length;
    optionRefs.current[next]?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() =>
      optionRefs.current[openingIndexRef.current]?.focus(),
    );
    const handleOutsidePress = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", handleOutsidePress, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", handleOutsidePress, true);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className={`atm-select atm-field-shell ${className}`.trim()}
      data-open={open ? "true" : "false"}
      data-placement={placement}
    >
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className="atm-select-trigger"
        role="combobox"
        aria-label={ariaLabel}
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => (open ? closeAndFocusTrigger() : openAt(selectedIndex))}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            openAt(selectedIndex);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            openAt(selectedIndex < 0 ? options.length - 1 : selectedIndex);
          }
        }}
      >
        <span>{selectedLabel}</span>
        <CaretDown size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div className="atm-select-popover" id={listboxId} role="listbox" aria-label={ariaLabel}>
          {options.map((option, index) => (
            <button
              ref={(element) => {
                optionRefs.current[index] = element;
              }}
              type="button"
              className="atm-select-option"
              role="option"
              aria-selected={option.value === value}
              data-selected={option.value === value ? "true" : "false"}
              key={option.value || "__empty"}
              onClick={() => choose(index)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  focusOption(index + 1);
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  focusOption(index - 1);
                } else if (event.key === "Home") {
                  event.preventDefault();
                  focusOption(0);
                } else if (event.key === "End") {
                  event.preventDefault();
                  focusOption(options.length - 1);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  closeAndFocusTrigger();
                } else if (event.key === "Tab") {
                  setOpen(false);
                }
              }}
            >
              <span>{option.label}</span>
              {option.value === value ? <CheckCircle size={15} weight="fill" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function formatTime(value?: string | null): string {
  if (!value) return "暂无";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function compactPath(value?: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "不可用";
  const parts = value.replaceAll("/", "\\").split("\\").filter(Boolean);
  return parts.length > 2 ? `…\\${parts.slice(-2).join("\\")}` : value;
}

function formatDuration(value?: string | null): string {
  const started = Date.parse(value ?? "");
  if (!Number.isFinite(started)) return "未知";
  const minutes = Math.max(0, Math.floor((Date.now() - started) / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

function LoadingRows({ count = 4 }: { count?: number }) {
  return (
    <div className="atm-panel-body" style={{ display: "grid", gap: 9 }}>
      {Array.from({ length: count }, (_, index) => (
        <div className="atm-skeleton" key={index} />
      ))}
    </div>
  );
}

function Empty({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return (
    <div className="atm-empty">
      <div>
        <strong>{title}</strong>
        <div>{text}</div>
        {action ? <div style={{ marginTop: 16 }}>{action}</div> : null}
      </div>
    </div>
  );
}

function ErrorState({ error }: { error: unknown }) {
  return (
    <div className="atm-error">
      <div>
        <strong>载入失败</strong>
        <div>{error instanceof Error ? error.message : String(error)}</div>
      </div>
    </div>
  );
}

function PageHead({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="atm-page-head">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions ? <div className="atm-actions">{actions}</div> : null}
    </header>
  );
}

function useDialogAccessibility(close: () => void) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusableSelector =
      "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])";
    const frame = window.requestAnimationFrame(() => {
      const preferred = dialog?.querySelector<HTMLElement>("[data-dialog-autofocus]");
      if (preferred) preferred.focus();
      else if (!dialog?.contains(document.activeElement))
        dialog?.querySelector<HTMLElement>(focusableSelector)?.focus();
    });
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(focusableSelector)].filter(
        (element) => !element.hidden && element.getClientRects().length > 0,
      );
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKey);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);
  return dialogRef;
}

function sidebarProjectHint(name: string): string {
  const isLongAsciiName =
    name.length > 28 &&
    /[A-Za-z]/u.test(name) &&
    Array.from(name).every((character) => (character.codePointAt(0) ?? 0) <= 0x7f);
  return isLongAsciiName ? `${name}\n名称较长，建议改用简洁中文名称。` : name;
}

function Sidebar({
  route,
  setRoute,
  projects,
  brandLogoSrc,
}: {
  route: Route;
  setRoute: (route: Route) => void;
  projects: RegisteredProject[];
  brandLogoSrc?: string;
}) {
  const primary = [
    ["overview", "总览", House],
    ["projects", "项目", FolderOpen],
  ] as const;
  const workspace = [
    ["my", "活动任务", CheckSquare],
    ["quick", "临时任务", Lightning],
    ["blockers", "阻塞与等待", WarningCircle],
    ["agents", "Agent", UsersThree],
    ["timeline", "全局时间线", ClockCounterClockwise],
  ] as const;
  const routeUsesWorkspace = workspace.some(([key]) => route === key);
  const [workspaceExpanded, setWorkspaceExpanded] = useState(() => {
    if (routeUsesWorkspace) return true;
    return window.localStorage.getItem("atm.workspace.expanded") === "true";
  });
  useEffect(() => {
    if (routeUsesWorkspace) setWorkspaceExpanded(true);
  }, [routeUsesWorkspace]);
  useEffect(() => {
    window.localStorage.setItem("atm.workspace.expanded", String(workspaceExpanded));
  }, [workspaceExpanded]);
  return (
    <aside className="atm-sidebar">
      <div className="atm-sidebar-inner">
        <div className="atm-brand" data-testid="window-drag-brand">
          <span className="atm-brand-mark">
            {brandLogoSrc ? (
              <img src={brandLogoSrc} alt="" aria-hidden="true" />
            ) : (
              <CheckSquare size={18} weight="bold" />
            )}
          </span>
          <span>AyanamiTaskManager</span>
        </div>
        <div className="atm-nav-group atm-primary-navigation">
          <nav className="atm-nav" aria-label="主导航">
            {primary.map(([key, label, Icon]) => (
              <button
                key={key}
                aria-current={route === key ? "page" : undefined}
                onClick={() => setRoute(key)}
              >
                <Icon size={18} />
                <span>{label}</span>
              </button>
            ))}
          </nav>
        </div>
        <div className="atm-nav-group atm-workspace-navigation">
          <button
            type="button"
            className="atm-nav-disclosure"
            aria-expanded={workspaceExpanded}
            aria-controls="atm-workspace-navigation"
            onClick={() => setWorkspaceExpanded((expanded) => !expanded)}
          >
            <CaretRight size={16} aria-hidden="true" />
            <span>工作区</span>
          </button>
          <nav
            className="atm-nav atm-nav-secondary"
            id="atm-workspace-navigation"
            aria-label="工作区"
            hidden={!workspaceExpanded}
          >
            {workspace.map(([key, label, Icon]) => (
              <button
                key={key}
                aria-current={route === key ? "page" : undefined}
                onClick={() => setRoute(key)}
              >
                <Icon size={18} />
                <span>{label}</span>
              </button>
            ))}
          </nav>
        </div>
        {projects.length ? (
          <div className="atm-nav-group">
            <div className="atm-nav-title">活动项目</div>
            <nav className="atm-nav">
              {projects
                .filter((project) => project.lifecycle === "ACTIVE")
                .slice(0, 12)
                .map((project) => (
                  <button
                    key={project.id}
                    className="atm-nav-project"
                    aria-current={route === `project:${project.code}` ? "page" : undefined}
                    aria-label={project.name}
                    title={sidebarProjectHint(project.name)}
                    onClick={() => setRoute(`project:${project.code}`)}
                  >
                    <span className="atm-nav-project-name">{project.name}</span>
                  </button>
                ))}
            </nav>
          </div>
        ) : null}
        <div className="atm-sidebar-footer">
          <button
            type="button"
            className="atm-sidebar-settings"
            aria-current={route === "settings" ? "page" : undefined}
            onClick={() => setRoute("settings")}
          >
            <GearSix size={18} />
            <span>设置</span>
          </button>
        </div>
      </div>
    </aside>
  );
}

function OverviewPage({
  client,
  onProject,
  onQuick,
  notify,
}: {
  client: AyanamiClient;
  onProject: (code: string) => void;
  onQuick: () => void;
  notify: Notify;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["overview"],
    queryFn: () => client.overview(),
  });
  const quickQuery = useQuery({
    queryKey: ["quick"],
    queryFn: () => client.quick.list(),
  });
  const completeQuick = useMutation({
    mutationFn: (task: any) =>
      client.quick.patch(String(task.id), {
        status: "DONE",
        expectedVersion: Number(task.version),
        actor: "USER",
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["quick"] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
      ]);
      notify("临时任务已完成");
    },
  });
  if (query.isLoading)
    return (
      <>
        <PageHead title="总览" description="项目状态、阻塞和最近变化集中在这里。" />
        <LoadingRows count={6} />
      </>
    );
  if (query.error) return <ErrorState error={query.error} />;
  const data = query.data!;
  const projects = ((data.projects ?? []) as any[]).filter(
    (project) => project.lifecycle !== "TRASHED",
  );
  const quickTasks = ((quickQuery.data ?? []) as any[])
    .filter((task) => !["DONE", "CANCELLED", "PROMOTED"].includes(task.status))
    .slice(0, 5);
  const active = projects.reduce((sum, project) => sum + Number(project.active_count ?? 0), 0);
  const blocked =
    projects.reduce((sum, project) => sum + Number(project.blocked_count ?? 0), 0) +
    Number(data.quick?.blocked ?? 0);
  const waiting = projects.reduce(
    (sum, project) =>
      sum + Number(project.waiting_user_count ?? 0) + Number(project.waiting_agent_count ?? 0),
    0,
  );
  const agents = projects.reduce(
    (sum, project) => sum + Number(project.active_agent_count ?? 0),
    0,
  );
  const attention = projects.flatMap((project) => {
    const items: string[] = [];
    if (Number(project.waiting_user_count ?? 0))
      items.push(`${project.code} 有 ${project.waiting_user_count} 项等待用户`);
    if (Number(project.blocked_count ?? 0))
      items.push(`${project.code} 有 ${project.blocked_count} 项阻塞`);
    if (Number(project.overdue_count ?? 0))
      items.push(`${project.code} 有 ${project.overdue_count} 项超期`);
    if (Number(project.stale_claim_count ?? 0))
      items.push(`${project.code} 有 ${project.stale_claim_count} 个过期 Agent 领取`);
    if (!project.last_project_update_at) items.push(`${project.code} 尚未发布项目更新`);
    if (project.lifecycle === "MIGRATION_FAILED") items.push(`${project.code} 数据库迁移失败`);
    return items;
  });
  if ((data.recentEvents as any[] | undefined)?.some((event) => event.type === "backup.failed"))
    attention.push("最近一次自动备份失败，请在设置与数据工具中检查");
  return (
    <>
      <PageHead title="总览" description="只显示已经写入事实源的项目状态，不展示模拟数据。" />
      <section className="atm-metrics five">
        <div className="atm-metric">
          <div className="label">进行中项目</div>
          <div className="value">
            {projects.filter((project) => project.lifecycle === "ACTIVE").length}
          </div>
        </div>
        <div className="atm-metric">
          <div className="label">进行中任务</div>
          <div className="value">{active}</div>
        </div>
        <div className="atm-metric">
          <div className="label">受阻</div>
          <div className="value">{blocked}</div>
        </div>
        <div className="atm-metric">
          <div className="label">等待</div>
          <div className="value">{waiting}</div>
        </div>
        <div className="atm-metric">
          <div className="label">在线 Agent</div>
          <div className="value">{agents}</div>
        </div>
      </section>
      {attention.length ? (
        <section className="atm-panel" style={{ marginBottom: 18 }}>
          <div className="atm-panel-head">
            <h2>需要处理</h2>
            <span className="atm-badge warning">{attention.length}</span>
          </div>
          <div className="atm-panel-body atm-attention-grid">
            {attention.slice(0, 12).map((item) => (
              <div className="atm-row-sub" key={item}>
                <WarningCircle size={15} /> {item}
              </div>
            ))}
          </div>
        </section>
      ) : null}
      <div className="atm-grid">
        <section className="atm-panel">
          <div className="atm-panel-head">
            <h2>项目状态</h2>
            <span className="atm-key">seq {data.sequence}</span>
          </div>
          {projects.length === 0 ? (
            <Empty title="还没有正式项目" text="从项目页创建第一个项目。" />
          ) : (
            <div className="atm-overview-projects">
              {projects.slice(0, 12).map((project) => (
                <button
                  className="atm-project atm-overview-project"
                  key={project.id}
                  onClick={() => onProject(project.code)}
                >
                  <div className="atm-actions" style={{ justifyContent: "space-between" }}>
                    <span className="atm-project-code">{project.code}</span>
                    <Status value={project.health ?? "UNKNOWN"} />
                  </div>
                  <h2>{project.name}</h2>
                  <div className="atm-row-sub">
                    {project.current_milestone ?? "尚未设置里程碑"} ·{" "}
                    {project.next_target_date ?? "无目标日期"}
                  </div>
                  <div className="atm-progress">
                    <span style={{ width: `${Number(project.progress ?? 0)}%` }} />
                  </div>
                  <div className="atm-row-sub">
                    {Math.round(Number(project.progress ?? 0))}% ·{" "}
                    {progressSourceLabels[project.progress_source] ?? "尚无进度"}
                  </div>
                  <div className="atm-project-stats">
                    <span>活动 {Number(project.active_count ?? 0)}</span>
                    <span>阻塞 {Number(project.blocked_count ?? 0)}</span>
                    <span>
                      等待{" "}
                      {Number(project.waiting_user_count ?? 0) +
                        Number(project.waiting_agent_count ?? 0)}
                    </span>
                    <span>Agent {Number(project.active_agent_count ?? 0)}</span>
                  </div>
                  <div className="atm-row-sub">最近活动 {formatTime(project.last_activity_at)}</div>
                </button>
              ))}
            </div>
          )}
        </section>
        <section className="atm-panel">
          <div className="atm-panel-head">
            <h2>最近变化</h2>
          </div>
          {(data.recentEvents ?? []).length === 0 ? (
            <Empty title="暂无事件" text="创建或更新任务后，变化会出现在这里。" />
          ) : (
            <div className="atm-timeline">
              {(data.recentEvents as Record<string, unknown>[]).slice(0, 8).map((event) => {
                const item = presentTimelineEvent(event);
                return <TimelineEventRow event={event} key={item.id} />;
              })}
            </div>
          )}
        </section>
      </div>
      <section className="atm-panel" style={{ marginTop: 18 }}>
        <div className="atm-panel-head">
          <h2>临时任务</h2>
          <button className="atm-button" onClick={onQuick}>
            <Plus size={16} />
            添加或晋升
          </button>
        </div>
        {quickQuery.isLoading ? (
          <LoadingRows count={3} />
        ) : quickTasks.length === 0 ? (
          <Empty title="没有待处理临时任务" text="适合几分钟内完成、无需拆分的工作。" />
        ) : (
          <div className="atm-list">
            {quickTasks.map((task) => (
              <div className="atm-row" key={task.id}>
                <label className="atm-check">
                  <input
                    type="checkbox"
                    aria-label={`完成 ${task.title}`}
                    disabled={completeQuick.isPending}
                    onChange={() => completeQuick.mutate(task)}
                  />
                  <span>
                    <span className="atm-row-title">{task.title}</span>
                    <span className="atm-row-sub">
                      {task.key} · {formatTime(task.updated_at ?? task.updatedAt)}
                    </span>
                  </span>
                </label>
                <Status value={task.status} />
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function ProjectWizard({
  client,
  close,
  notify,
  onCreated,
  desktop,
}: {
  client: AyanamiClient;
  close: () => void;
  notify: Notify;
  onCreated: (code: string) => void;
  desktop?: DesktopBridge;
}) {
  const queryClient = useQueryClient();
  const dialogRef = useDialogAccessibility(close);
  const [step, setStep] = useState(0);
  const [connection, setConnection] = useState<"" | "正在测试" | "连接正常">("");
  const [form, setForm] = useState({
    name: "",
    code: "",
    path: "",
    description: "",
    mode: "AUTO",
    objective: "",
    milestone: "",
  });
  const configs = useQuery({
    queryKey: ["wizard-mcp-configs"],
    queryFn: () => desktop!.getMcpConfigs!(),
    enabled: step === 2 && Boolean(desktop?.getMcpConfigs),
  });
  const install = useMutation({
    mutationFn: (target: McpClient) => desktop!.installMcp!(target),
    onSuccess: (result) => notify(`Agent 配置已安装：${result.path}`),
    onError: (error) =>
      notify(`Agent 配置安装失败：${error instanceof Error ? error.message : String(error)}`),
  });
  const mutation = useMutation({
    mutationFn: async () => {
      const project = await client.projects.create({
        name: form.name,
        sourcePath: form.path.trim() || null,
        description: form.description,
        coordinationMode: form.mode as "SOLO" | "AUTO" | "MULTI",
        ...(form.code.trim() ? { code: form.code.trim() } : {}),
      });
      if (form.objective.trim()) {
        const objective = await client.projects.createObjectiveAsUser(project.code, {
          opId: `ui-objective-${crypto.randomUUID()}`,
          title: form.objective.trim(),
          description: "",
          definitionOfDone: [],
        });
        if (form.milestone.trim())
          await client.projects.createMilestoneAsUser(project.code, {
            opId: `ui-milestone-${crypto.randomUUID()}`,
            objectiveId: objective.id,
            title: form.milestone.trim(),
            description: "",
          });
      }
      return project;
    },
    onSuccess: async (project) => {
      await queryClient.invalidateQueries();
      notify(`已创建项目 ${project.code}`);
      close();
      onCreated(project.code);
    },
  });
  const field = (key: keyof typeof form, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));
  return (
    <div className="atm-modal-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="atm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-wizard-title"
        tabIndex={-1}
      >
        <header className="atm-modal-head">
          <h2 id="project-wizard-title">新建项目</h2>
          <button className="atm-button atm-icon-button" aria-label="关闭" onClick={close}>
            <X size={17} />
          </button>
        </header>
        <div className="atm-modal-body">
          <div className="atm-actions" style={{ marginBottom: 20 }}>
            <span className={`atm-badge ${step === 0 ? "primary" : ""}`}>选择与配置</span>
            <span className={`atm-badge ${step === 1 ? "primary" : ""}`}>目标与里程碑</span>
            <span className={`atm-badge ${step === 2 ? "primary" : ""}`}>接入 Agent</span>
          </div>
          {step === 0 ? (
            <div className="atm-form">
              <div className="atm-form-grid">
                <div className="atm-field">
                  <label htmlFor="project-name">项目名称</label>
                  <input
                    id="project-name"
                    value={form.name}
                    onChange={(e) => field("name", e.target.value)}
                    data-dialog-autofocus
                  />
                </div>
                <div className="atm-field">
                  <label htmlFor="project-code">短代码</label>
                  <input
                    id="project-code"
                    value={form.code}
                    onChange={(e) => field("code", e.target.value.toUpperCase())}
                    placeholder="留空自动生成"
                  />
                </div>
              </div>
              <div className="atm-field">
                <label htmlFor="project-path">源码目录</label>
                <input
                  id="project-path"
                  value={form.path}
                  onChange={(e) => field("path", e.target.value)}
                  placeholder="可留空，适合研究或纯文档项目"
                />
                <small>正式项目数据会分配到受管目录，不会写入源码目录。</small>
              </div>
              <div className="atm-field">
                <label htmlFor="project-description">简短目标</label>
                <textarea
                  id="project-description"
                  value={form.description}
                  onChange={(e) => field("description", e.target.value)}
                />
              </div>
              <div className="atm-field">
                <label htmlFor="project-mode">协作模式</label>
                <AtmSelect
                  id="project-mode"
                  ariaLabel="协作模式"
                  value={form.mode}
                  options={[
                    { value: "SOLO", label: "单 Agent" },
                    { value: "AUTO", label: "自动判断" },
                    { value: "MULTI", label: "多 Agent" },
                  ]}
                  onChange={(mode) => field("mode", mode)}
                />
              </div>
            </div>
          ) : step === 1 ? (
            <div className="atm-form">
              <div className="atm-field">
                <label htmlFor="project-objective">当前目标</label>
                <input
                  id="project-objective"
                  value={form.objective}
                  onChange={(e) => field("objective", e.target.value)}
                  data-dialog-autofocus
                />
                <small>可以暂时留空，但创建正式任务前必须有活动目标。</small>
              </div>
              <div className="atm-field">
                <label htmlFor="project-milestone">首个里程碑</label>
                <input
                  id="project-milestone"
                  value={form.milestone}
                  onChange={(e) => field("milestone", e.target.value)}
                />
              </div>
            </div>
          ) : (
            <div className="atm-form">
              <div className="atm-row">
                <div>
                  <div className="atm-row-title">{form.name}</div>
                  <div className="atm-row-sub">
                    {form.code || "自动短代码"} · {statusLabels[form.mode] ?? form.mode} ·{" "}
                    {form.path || "无目录项目"}
                  </div>
                </div>
                <Status value={connection === "连接正常" ? "ACTIVE" : "UNKNOWN"} />
              </div>
              {desktop?.getMcpConfigs ? (
                <>
                  <div className="atm-row-sub">
                    MCP 服务将在项目创建后通过同一本地服务识别该项目。
                  </div>
                  <div className="atm-actions">
                    <button
                      className="atm-button"
                      disabled={install.isPending || !desktop.installMcp}
                      onClick={() => install.mutate("CODEX")}
                    >
                      安装到 Codex
                    </button>
                    <button
                      className="atm-button"
                      disabled={install.isPending || !desktop.installMcp}
                      onClick={() => install.mutate("CLAUDE")}
                    >
                      安装到 Claude Desktop
                    </button>
                    <button
                      className="atm-button"
                      disabled={install.isPending || !desktop.installMcp}
                      onClick={() => install.mutate("CLAUDE_CODE")}
                    >
                      安装到 Claude Code
                    </button>
                    <button
                      className="atm-button"
                      disabled={!configs.data || !desktop.copyText}
                      onClick={() => void desktop.copyText!(configs.data!.stdio)}
                    >
                      复制通用配置
                    </button>
                    <button
                      className="atm-button"
                      onClick={async () => {
                        setConnection("正在测试");
                        await client.status();
                        setConnection("连接正常");
                      }}
                    >
                      运行连接测试
                    </button>
                  </div>
                  <div className="atm-row-sub">
                    {connection || (configs.isLoading ? "正在读取 MCP 配置" : "等待连接测试")}
                  </div>
                </>
              ) : (
                <div className="atm-row-sub">
                  浏览器预览模式可创建项目；Agent 自动安装请在桌面应用设置中完成。
                </div>
              )}
            </div>
          )}
          {mutation.error || install.error ? (
            <div className="atm-inline-error" style={{ marginTop: 14 }}>
              {mutation.error instanceof Error
                ? mutation.error.message
                : install.error instanceof Error
                  ? install.error.message
                  : String(mutation.error ?? install.error)}
            </div>
          ) : null}
        </div>
        <footer className="atm-modal-foot">
          {step > 0 ? (
            <button className="atm-button" onClick={() => setStep(step - 1)}>
              上一步
            </button>
          ) : null}
          {step < 2 ? (
            <button
              className="atm-button primary"
              disabled={step === 0 && !form.name.trim()}
              onClick={() => setStep(step + 1)}
            >
              下一步 <ArrowRight size={16} />
            </button>
          ) : (
            <button
              className="atm-button primary"
              disabled={!form.name.trim() || mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              {mutation.isPending ? "正在创建" : "创建并打开项目"}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

function ProjectsPage({
  client,
  onProject,
  notify,
  desktop,
}: {
  client: AyanamiClient;
  onProject: (code: string) => void;
  notify: Notify;
  desktop?: DesktopBridge;
}) {
  const [wizard, setWizard] = useState(false);
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["projects"], queryFn: () => client.projects.list() });
  const restore = useMutation({
    mutationFn: (code: string) => client.projects.restore(code),
    onSuccess: async (project) => {
      await queryClient.invalidateQueries();
      notify(`已从垃圾箱恢复 ${project.code}`);
    },
  });
  return (
    <>
      <PageHead
        title="项目"
        description="每个正式项目拥有独立 SQLite 文件和可移动的路径别名。"
        actions={
          <button className="atm-button primary" onClick={() => setWizard(true)}>
            <Plus size={16} />
            新建项目
          </button>
        }
      />
      {query.isLoading ? (
        <LoadingRows count={5} />
      ) : query.error ? (
        <ErrorState error={query.error} />
      ) : query.data!.length === 0 ? (
        <section className="atm-panel">
          <Empty
            title="还没有项目"
            text="创建项目后，可以组织目标、里程碑和任务。"
            action={
              <button className="atm-button primary" onClick={() => setWizard(true)}>
                创建第一个项目
              </button>
            }
          />
        </section>
      ) : (
        <section className="atm-project-grid">
          {query.data!.map((project) => (
            <article className="atm-project" key={project.id}>
              <button
                className="atm-project-main"
                disabled={project.lifecycle === "TRASHED"}
                onClick={() => onProject(project.code)}
              >
                <div>
                  <span className="atm-project-code">{project.code}</span>
                  <Status value={project.lifecycle} />
                </div>
                <h2>{project.name}</h2>
                <p>{project.description || "尚未填写项目说明"}</p>
                <div className="atm-project-footer">
                  <span className="atm-row-sub">{project.sourcePaths[0] ?? "无源码目录"}</span>
                  {project.lifecycle === "TRASHED" ? null : <ArrowRight size={18} />}
                </div>
              </button>
              {project.lifecycle === "TRASHED" ? (
                <button
                  className="atm-button"
                  disabled={restore.isPending}
                  onClick={() => restore.mutate(project.code)}
                >
                  <ArrowCounterClockwise size={16} />
                  恢复项目
                </button>
              ) : null}
            </article>
          ))}
        </section>
      )}
      {wizard ? (
        <ProjectWizard
          client={client}
          close={() => setWizard(false)}
          notify={notify}
          onCreated={onProject}
          {...(desktop ? { desktop } : {})}
        />
      ) : null}
    </>
  );
}

function useAllProjectTasks(client: AyanamiClient, projects: RegisteredProject[]) {
  return useQueries({
    queries: projects
      .filter((project) => project.lifecycle === "ACTIVE")
      .map((project) => ({
        queryKey: ["tasks", project.code],
        queryFn: () => client.tasks.list(project.code, { limit: 100 }),
        staleTime: 5000,
        select: (tasks: any[]) =>
          tasks.map((task) => ({ ...task, project: project.code, projectName: project.name })),
      })),
  });
}

function TasksAcrossProjects({
  client,
  projects,
  mode,
  onTask,
}: {
  client: AyanamiClient;
  projects: RegisteredProject[];
  mode: "active" | "blocked";
  onTask: (project: string, key: string) => void;
}) {
  const queries = useAllProjectTasks(client, projects);
  if (queries.some((query) => query.isLoading)) return <LoadingRows count={6} />;
  const error = queries.find((query) => query.error)?.error;
  if (error) return <ErrorState error={error} />;
  const statuses =
    mode === "active"
      ? ["CLAIMED", "IN_PROGRESS", "VERIFYING"]
      : ["BLOCKED", "WAITING_USER", "WAITING_AGENT"];
  const tasks = queries
    .flatMap((query) => query.data ?? [])
    .filter((task: any) => statuses.includes(task.status));
  if (!tasks.length)
    return (
      <section className="atm-panel">
        <Empty
          title={mode === "active" ? "没有活动任务" : "没有阻塞或等待"}
          text={
            mode === "active" ? "任务被领取或开始后会出现在这里。" : "当前没有需要外部处理的任务。"
          }
        />
      </section>
    );
  return (
    <section className="atm-panel">
      <table className="atm-table">
        <colgroup>
          <col style={{ width: "38%" }} />
          <col style={{ width: "20%" }} />
          <col style={{ width: "12%" }} />
          <col style={{ width: "20%" }} />
          <col style={{ width: "10%" }} />
        </colgroup>
        <thead>
          <tr>
            <th>任务</th>
            <th>项目</th>
            <th>状态</th>
            <th>负责人</th>
            <th>进度</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task: any) => (
            <tr key={task.id} onClick={() => onTask(task.project, task.key)}>
              <td>
                <div className="atm-row-title">{task.title}</div>
                <span className="atm-key">{task.key}</span>
              </td>
              <td>{task.projectName}</td>
              <td>
                <Status value={task.status} />
              </td>
              <td>{task.assigneeAgentId ?? "未分配"}</td>
              <td className="atm-key">{Math.round(task.progress ?? 0)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function QuickPage({ client, notify }: { client: AyanamiClient; notify: Notify }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [targetProject, setTargetProject] = useState("");
  const query = useQuery({ queryKey: ["quick"], queryFn: () => client.quick.list() });
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => client.projects.list() });
  useEffect(() => {
    if (!targetProject)
      setTargetProject(
        projects.data?.find((project) => project.lifecycle === "ACTIVE")?.code ?? "",
      );
  }, [projects.data, targetProject]);
  const create = useMutation({
    mutationFn: () => client.quick.create({ title, note: "", actor: "USER" }),
    onSuccess: async () => {
      setTitle("");
      await queryClient.invalidateQueries({ queryKey: ["quick"] });
      await queryClient.invalidateQueries({ queryKey: ["overview"] });
      notify("已添加临时任务");
    },
  });
  const patch = useMutation({
    mutationFn: ({ id, status, version }: { id: string; status: string; version: number }) =>
      client.quick.patch(id, { status, expectedVersion: version, actor: "USER" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["quick"] }),
  });
  const promote = useMutation({
    mutationFn: (task: any) =>
      client.quick.promote(task.id, {
        expectedVersion: task.version,
        targetProjectCode: targetProject,
        actor: "USER",
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      notify(`临时任务已晋升到 ${targetProject}`);
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (title.trim()) create.mutate();
  };
  return (
    <>
      <PageHead
        title="临时任务"
        description="一次性、低复杂度工作留在全局注册库，需要持续管理时再晋升为项目。"
        actions={
          <AtmSelect
            className="wide"
            ariaLabel="晋升目标项目"
            value={targetProject}
            options={[
              { value: "", label: "选择晋升目标" },
              ...(projects.data ?? [])
                .filter((project) => project.lifecycle === "ACTIVE")
                .map((project) => ({
                  value: project.code,
                  label: `${project.code} · ${project.name}`,
                })),
            ]}
            onChange={setTargetProject}
          />
        }
      />
      <section className="atm-panel" style={{ marginBottom: 16 }}>
        <form className="atm-panel-body" onSubmit={submit} style={{ display: "flex", gap: 9 }}>
          <input
            className="atm-filter"
            style={{ flex: 1 }}
            aria-label="临时任务标题"
            placeholder="添加一件临时任务"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <button className="atm-button primary" disabled={!title.trim() || create.isPending}>
            <Plus size={16} />
            添加
          </button>
        </form>
      </section>
      <section className="atm-panel">
        {query.isLoading ? (
          <LoadingRows />
        ) : query.error ? (
          <ErrorState error={query.error} />
        ) : query.data!.length === 0 ? (
          <Empty title="没有临时任务" text="适合几分钟内完成、无需拆分的工作。" />
        ) : (
          <div className="atm-list">
            {query.data!.map((task: any) => (
              <div className="atm-row" key={task.id}>
                <div>
                  <div className="atm-row-title">{task.title}</div>
                  <div className="atm-row-sub">
                    {task.key} · 更新于 {formatTime(task.updatedAt)}
                  </div>
                </div>
                <div className="atm-actions">
                  <Status value={task.status} />
                  {["OPEN", "IN_PROGRESS", "BLOCKED"].includes(task.status) ? (
                    <button
                      className="atm-button"
                      disabled={!targetProject || promote.isPending}
                      onClick={() => promote.mutate(task)}
                    >
                      晋升
                    </button>
                  ) : null}
                  {task.status === "OPEN" ? (
                    <button
                      className="atm-button atm-icon-button"
                      aria-label="开始"
                      onClick={() =>
                        patch.mutate({ id: task.id, status: "IN_PROGRESS", version: task.version })
                      }
                    >
                      <Play size={16} />
                    </button>
                  ) : null}
                  {["OPEN", "IN_PROGRESS", "BLOCKED"].includes(task.status) ? (
                    <button
                      className="atm-button atm-icon-button"
                      aria-label="完成"
                      onClick={() =>
                        patch.mutate({ id: task.id, status: "DONE", version: task.version })
                      }
                    >
                      <CheckCircle size={17} />
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      {promote.error ? (
        <div className="atm-inline-error" style={{ marginTop: 12 }}>
          {promote.error instanceof Error ? promote.error.message : String(promote.error)}
        </div>
      ) : null}
    </>
  );
}

function AgentsPage({
  client,
  projects,
}: {
  client: AyanamiClient;
  projects: RegisteredProject[];
}) {
  const queryClient = useQueryClient();
  const queries = useQueries({
    queries: projects
      .filter((project) => project.lifecycle === "ACTIVE")
      .map((project) => ({
        queryKey: ["agents", project.code],
        queryFn: async () =>
          (await client.projects.agents(project.code)).map((agent) => ({
            ...agent,
            project: project.code,
          })),
      })),
  });
  const forceClose = useMutation({
    mutationFn: (session: any) =>
      client.sessions.forceClose(String(session.id), String(session.project), true),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["agents"] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
      ]);
    },
  });
  const refreshGit = useMutation({
    mutationFn: (session: any) =>
      client.sessions.refreshGitContext(String(session.id), String(session.project)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });
  if (queries.some((query) => query.isLoading))
    return (
      <>
        <PageHead title="Agent" description="项目内已注册的 Agent 会话和最近活动。" />
        <LoadingRows />
      </>
    );
  const allSessions = queries.flatMap((query) => query.data ?? []) as AgentSessionLike[];
  const projectGroups = groupAgentSessions(allSessions);
  const conflicts = findAgentSessionConflicts(allSessions);
  return (
    <>
      <PageHead
        title="Agent"
        description="按项目与 Agent 身份聚合正式 Session；保留历史数量，并可关闭异常在线会话。"
      />
      {conflicts.length ? (
        <div className="atm-notice" role="status">
          {conflicts.map((conflict) => (
            <div key={`${conflict.kind}:${conflict.value}`}>
              ⚠ {conflict.count} 个活动 Session 正在使用同一
              {conflict.kind === "SAME_WORKTREE" ? " Worktree" : " Git branch"}：
              {compactPath(conflict.value)}
            </div>
          ))}
        </div>
      ) : null}
      <section className="atm-panel">
        {projectGroups.length === 0 ? (
          <Empty title="没有 Agent 会话" text="Agent 调用 atm_begin 后会在这里出现。" />
        ) : (
          <div className="agent-project-groups">
            {projectGroups.map((group) => (
              <details
                className="agent-project-group"
                data-agent-project={group.project}
                key={group.project}
                open
              >
                <summary className="agent-project-heading">
                  <span className="agent-project-title">
                    <FolderOpen size={18} aria-hidden="true" />
                    <span>{group.project}</span>
                  </span>
                  <span className="agent-project-stats">
                    <span>{group.agents.length} 个 Agent</span>
                    <span>{group.sessionCount} 个 Session</span>
                    <Status value={group.onlineCount ? "ONLINE" : "CLOSED"} />
                  </span>
                </summary>
                <div className="agent-session-grid">
                  {group.agents.map((session: any) => (
                    <article
                      className="agent-session-card"
                      data-agent-id={session.agent_id}
                      key={`${session.project}:${session.agent_id}`}
                    >
                      <header className="agent-session-card-header">
                        <div className="agent-session-identity">
                          <div className="atm-row-title">
                            {session.display_name || session.agent_id || "未命名 Agent"}
                          </div>
                          <div className="atm-row-sub">
                            <span className="atm-key">{session.agent_id}</span> ·{" "}
                            {session.sessionCount} 个 Session
                          </div>
                        </div>
                        <div className="agent-session-status">
                          <Status value={String(session.connection_state || "UNKNOWN")} />
                          <span className="atm-row-sub">{session.work_state || "空闲"}</span>
                        </div>
                      </header>

                      <div className="agent-session-primary-grid">
                        <div className="agent-session-field">
                          <span>当前任务</span>
                          <strong>{session.current_task_key || "未领取"}</strong>
                        </div>
                        <div className="agent-session-field">
                          <span>角色</span>
                          <strong>{statusLabels[session.role] ?? session.role ?? "未知"}</strong>
                        </div>
                        <div className="agent-session-field">
                          <span>Git branch</span>
                          <strong title={session.git_branch || ""}>
                            {session.git_branch || "非 Git"}
                          </strong>
                        </div>
                        <div className="agent-session-field">
                          <span>Worktree</span>
                          <strong title={session.worktree_root || ""}>
                            {compactPath(session.worktree_root)}
                          </strong>
                        </div>
                      </div>

                      <details className="agent-session-audit">
                        <summary>
                          详细上下文与历史 <span className="atm-key">({session.sessionCount})</span>
                        </summary>
                        <div className="agent-session-detail-grid">
                          <div>
                            <span>当前 Session</span>
                            <strong>{session.id}</strong>
                          </div>
                          <div title={session.cwd || ""}>
                            <span>工作目录</span>
                            <strong>{compactPath(session.cwd)}</strong>
                          </div>
                          <div>
                            <span>HEAD</span>
                            <strong>{String(session.git_head || "不可用").slice(0, 10)}</strong>
                          </div>
                          <div>
                            <span>Git 状态</span>
                            <strong>
                              {Number(session.git_available) === 1 || session.git_available === true
                                ? Number(session.git_dirty) === 1 || session.git_dirty === true
                                  ? "dirty"
                                  : "clean"
                                : session.git_error || "未观察"}
                            </strong>
                          </div>
                          <div>
                            <span>最后活动</span>
                            <strong>{formatTime(session.last_seen_at)}</strong>
                          </div>
                          <div>
                            <span>持续时间</span>
                            <strong>{formatDuration(session.started_at)}</strong>
                          </div>
                        </div>
                        {session.sessionHistory.length > 1 ? (
                          <div className="agent-session-history" aria-label="历史 Session">
                            <div className="agent-session-history-title">历史 Session</div>
                            {session.sessionHistory.map((history: any) => (
                              <div className="agent-session-history-row" key={history.id}>
                                <span className="atm-key">{history.id}</span>
                                <Status value={String(history.connection_state || "UNKNOWN")} />
                                <span>{formatTime(history.last_seen_at)}</span>
                                {history.id === session.id ? (
                                  <span className="atm-row-sub">当前</span>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </details>

                      <footer className="agent-session-actions">
                        <span className="atm-row-sub">
                          最近活动：{formatTime(session.last_seen_at)}
                        </span>
                        <span className="atm-actions">
                          <button
                            className="atm-button"
                            disabled={refreshGit.isPending}
                            onClick={() => refreshGit.mutate(session)}
                          >
                            刷新 Git
                          </button>
                          {session.connection_state === "ONLINE" ? (
                            <button
                              className="atm-button danger"
                              disabled={forceClose.isPending}
                              onClick={() => {
                                if (window.confirm("关闭该异常 Session 并释放其任务领取？"))
                                  forceClose.mutate(session);
                              }}
                            >
                              关闭并释放
                            </button>
                          ) : null}
                        </span>
                      </footer>
                    </article>
                  ))}
                </div>
              </details>
            ))}
          </div>
        )}
      </section>
      {forceClose.error ? (
        <div className="atm-inline-error" style={{ marginTop: 12 }}>
          {forceClose.error instanceof Error ? forceClose.error.message : String(forceClose.error)}
        </div>
      ) : null}
    </>
  );
}

function TimelineEventRow({ event }: { event: Record<string, unknown> }) {
  const item = presentTimelineEvent(event);
  const project = item.projectName ?? item.projectCode;
  return (
    <article className="atm-event" data-event-type={item.type}>
      {project || item.subjectKey ? (
        <div className="atm-event-context">
          {project ? <span>{project}</span> : null}
          {item.subjectKey ? <strong>{item.subjectKey}</strong> : null}
        </div>
      ) : null}
      <div className="atm-row-title">{item.title}</div>
      {item.detail && item.detail !== item.title ? (
        <p className="atm-event-detail">{item.detail}</p>
      ) : null}
      <div className="atm-row-sub atm-event-meta">
        <span>{item.category}</span>
        {item.actor ? <span>{item.actor}</span> : null}
        {item.sequence === null ? null : <span>序列 {item.sequence}</span>}
        {item.occurredAt ? (
          <time dateTime={item.occurredAt}>{formatTime(item.occurredAt)}</time>
        ) : null}
      </div>
    </article>
  );
}

function TimelinePage({ client }: { client: AyanamiClient }) {
  const query = useQuery({ queryKey: ["overview"], queryFn: () => client.overview() });
  return (
    <>
      <PageHead
        title="全局时间线"
        description="跨项目的投影事件，用于快速定位最近发生的状态变化。"
      />
      <section className="atm-panel">
        {query.isLoading ? (
          <LoadingRows />
        ) : query.error ? (
          <ErrorState error={query.error} />
        ) : !(query.data!.recentEvents ?? []).length ? (
          <Empty title="没有全局事件" text="项目或临时任务产生变化后会显示在这里。" />
        ) : (
          <div className="atm-timeline">
            {(query.data!.recentEvents as Record<string, unknown>[]).map((event) => {
              const item = presentTimelineEvent(event);
              return <TimelineEventRow event={event} key={item.id} />;
            })}
          </div>
        )}
      </section>
    </>
  );
}

const integrationStateLabels: Record<AgentIntegrationState, string> = {
  NOT_INSTALLED: "未安装",
  INSTALLED: "已安装",
  NEEDS_UPDATE: "需要更新",
  MODIFIED: "内容被修改",
};

function AgentIntegrationBadge({ state }: { state: AgentIntegrationState }) {
  return (
    <span className="atm-integration-status" data-state={state}>
      {integrationStateLabels[state]}
    </span>
  );
}

function integrationState(report: AgentIntegrationReport): AgentIntegrationState {
  const states = [report.rule.state, report.skills.state];
  if (states.includes("MODIFIED")) return "MODIFIED";
  if (states.includes("NEEDS_UPDATE")) return "NEEDS_UPDATE";
  if (report.mcpInstalled && states.every((state) => state === "INSTALLED")) return "INSTALLED";
  return "NOT_INSTALLED";
}

function agentClientLabel(client: McpClient): string {
  if (client === "CODEX") return "Codex";
  if (client === "CLAUDE_CODE") return "Claude Code";
  return "Claude Desktop";
}

function SettingsPage({ client, desktop }: { client: AyanamiClient; desktop?: DesktopBridge }) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["status"], queryFn: () => client.status() });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => client.settings.list() });
  const configs = useQuery({
    queryKey: ["mcp-configs"],
    queryFn: () => desktop!.getMcpConfigs!(),
    enabled: Boolean(desktop?.getMcpConfigs),
  });
  const integrations = useQuery({
    queryKey: ["agent-integrations"],
    queryFn: () => desktop!.getAgentIntegrations!(),
    enabled: Boolean(desktop?.getAgentIntegrations),
  });
  const updateStatus = useQuery({
    queryKey: ["desktop-update-status"],
    queryFn: () => desktop!.getUpdateStatus!(),
    enabled: Boolean(desktop?.getUpdateStatus),
    refetchInterval: 30_000,
  });
  const [autoLaunch, setAutoLaunch] = useState<boolean | null>(null);
  const [memoryProfile, setMemoryProfile] = useState<boolean | null>(null);
  const [memoryProfilePending, setMemoryProfilePending] = useState(false);
  const [memoryProfileError, setMemoryProfileError] = useState("");
  const [memoryProfileNotice, setMemoryProfileNotice] = useState("");
  const [dailyEnabled, setDailyEnabled] = useState(true);
  const [dailyKeep, setDailyKeep] = useState(7);
  const [weeklyKeep, setWeeklyKeep] = useState(4);
  const [notificationMode, setNotificationMode] = useState<NotificationMode>("ALL");
  const [feedback, setFeedback] = useState("");
  const [integrationPreview, setIntegrationPreview] = useState<{
    client: McpClient;
    current: string;
    proposed: string;
  } | null>(null);
  useEffect(() => {
    void desktop?.getAutoLaunch?.().then(setAutoLaunch);
  }, [desktop]);
  useEffect(() => {
    void desktop
      ?.getMemoryProfile?.()
      .then(setMemoryProfile)
      .catch((error: unknown) => {
        setMemoryProfileError(error instanceof Error ? error.message : String(error));
      });
  }, [desktop]);
  useEffect(() => {
    if (!settings.data) return;
    const backup = settings.data.find((entry) => entry.key === "backup.policy")?.value as any;
    const notification = settings.data.find((entry) => entry.key === "notification.mode")?.value;
    const legacyNotification = settings.data.find(
      (entry) => entry.key === "notification.enabled",
    )?.value;
    if (backup) {
      setDailyEnabled(backup.enabled !== false);
      setDailyKeep(Number(backup.dailyKeep ?? 7));
      setWeeklyKeep(Number(backup.weeklyKeep ?? 4));
    }
    if (["ALL", "CRITICAL", "OFF"].includes(String(notification))) {
      setNotificationMode(notification as NotificationMode);
    } else if (legacyNotification === false) {
      setNotificationMode("OFF");
    }
  }, [settings.data]);
  const savePolicy = useMutation({
    mutationFn: async () => {
      const backup = settings.data?.find((entry) => entry.key === "backup.policy");
      const notification = settings.data?.find((entry) => entry.key === "notification.mode");
      const legacyNotification = settings.data?.find(
        (entry) => entry.key === "notification.enabled",
      );
      await client.settings.put(
        "backup.policy",
        { enabled: dailyEnabled, dailyKeep, weeklyKeep },
        Number(backup?.version ?? -1),
      );
      await client.settings.put(
        "notification.mode",
        notificationMode,
        Number(notification?.version ?? -1),
      );
      await client.settings.put(
        "notification.enabled",
        notificationMode !== "OFF",
        Number(legacyNotification?.version ?? -1),
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
      setFeedback("设置已保存");
    },
  });
  const manageIntegration = useMutation({
    mutationFn: ({ client, action }: { client: McpClient; action: AgentIntegrationAction }) =>
      desktop!.manageAgentIntegration!(client, action),
    onSuccess: async (result, variables) => {
      if (result.preview) {
        setIntegrationPreview({ client: variables.client, ...result.preview });
        setFeedback(`${agentClientLabel(variables.client)} 修改预览已生成`);
        return;
      }
      setIntegrationPreview(null);
      await queryClient.invalidateQueries({ queryKey: ["agent-integrations"] });
      setFeedback(
        `${agentClientLabel(variables.client)} Agent 接入已${
          variables.action === "UNINSTALL" ? "卸载" : "更新"
        }`,
      );
    },
  });
  const checkUpdate = useMutation({
    mutationFn: () => desktop!.checkForUpdates!(),
    onSuccess: (status) => {
      queryClient.setQueryData(["desktop-update-status"], status);
      setFeedback(status?.message ?? "更新检查已启动");
    },
  });
  const copy = async (text: string, label: string) => {
    if (desktop?.copyText) await desktop.copyText(text);
    else await navigator.clipboard.writeText(text);
    setFeedback(`${label}已复制`);
  };
  return (
    <>
      <PageHead title="设置" description="本地服务、Agent 接入、自动备份和 Windows 启动行为。" />
      <div className="atm-settings-grid">
        <section className="atm-panel">
          <div className="atm-panel-head">
            <h2>服务与数据库</h2>
          </div>
          {query.isLoading ? (
            <LoadingRows />
          ) : query.error ? (
            <ErrorState error={query.error} />
          ) : (
            <div className="atm-panel-body atm-form">
              <div className="atm-row">
                <div>
                  <div className="atm-row-title">本地服务</div>
                  <div className="atm-row-sub">仅绑定 127.0.0.1，并要求本地令牌</div>
                </div>
                <Status value={query.data!.ok ? "ACTIVE" : "MIGRATION_FAILED"} />
              </div>
              <div className="atm-row">
                <div>
                  <div className="atm-row-title">SQLite</div>
                  <div className="atm-row-sub">
                    FTS5 {String((query.data!.sqlite as any)?.fts5)} · trigram{" "}
                    {String((query.data!.sqlite as any)?.trigram)} · WAL{" "}
                    {String((query.data!.sqlite as any)?.wal)}
                  </div>
                </div>
                <span className="atm-key">
                  {String((query.data!.sqlite as any)?.sqliteVersion ?? "")}
                </span>
              </div>
              <div className="atm-row">
                <div>
                  <div className="atm-row-title">项目数据库</div>
                  <div className="atm-row-sub">独立文件并通过 quick_check</div>
                </div>
                <span className="atm-key">{String(query.data!.projectCount)}</span>
              </div>
            </div>
          )}
        </section>
        <section className="atm-panel">
          <div className="atm-panel-head">
            <h2>Agent 接入</h2>
          </div>
          <div className="atm-panel-body atm-form">
            {desktop?.getMcpConfigs ? (
              <>
                {configs.isLoading ? (
                  <LoadingRows count={3} />
                ) : configs.error ? (
                  <ErrorState error={configs.error} />
                ) : (
                  <>
                    <div className="atm-row-sub">
                      只管理 ATM 的 MCP、全局规则 block 与两个 Skill；写入前备份，不覆盖其他内容。
                    </div>
                    {desktop?.setMemoryProfile ? (
                      <div className="atm-row" data-testid="memory-profile-toggle">
                        <div>
                          <div className="atm-row-title">memory 工具面</div>
                          <div className="atm-row-sub">
                            默认开启完整工具面。关闭可减少每个客户端一个常驻 bridge 进程（约 32
                            MiB），但关闭后将失去
                            atm_task_patch、atm_progress_add、atm_record、atm_search、atm_delta
                            五个工具。切换后请重载或重启 Agent 客户端。
                          </div>
                          {memoryProfileError ? (
                            <div className="atm-inline-error" role="alert">
                              切换失败，偏好未保存：{memoryProfileError}
                            </div>
                          ) : memoryProfileNotice ? (
                            <div className="atm-row-sub" role="status">
                              {memoryProfileNotice}
                            </div>
                          ) : null}
                        </div>
                        <button
                          className="atm-button"
                          disabled={memoryProfile === null || memoryProfilePending}
                          onClick={async () => {
                            setMemoryProfilePending(true);
                            setMemoryProfileError("");
                            setMemoryProfileNotice("");
                            try {
                              const result = await desktop.setMemoryProfile!(!memoryProfile);
                              setMemoryProfile(result.enabled);
                              const updated = result.clients.filter(
                                (entry) => entry.status === "UPDATED",
                              ).length;
                              setMemoryProfileNotice(
                                `已同步 ${updated} 个 Agent 配置；请重载或重启客户端生效。`,
                              );
                              // 开关改的是「该装哪些 server」，已安装状态与可复制的配置文本
                              // 都跟着变，两个都要重新取，否则界面停在改之前的样子。
                              await queryClient.invalidateQueries({
                                queryKey: ["agent-integrations"],
                              });
                              await queryClient.invalidateQueries({ queryKey: ["mcp-configs"] });
                            } catch (error) {
                              setMemoryProfileError(
                                error instanceof Error ? error.message : String(error),
                              );
                            } finally {
                              setMemoryProfilePending(false);
                            }
                          }}
                        >
                          {memoryProfilePending ? "正在同步" : memoryProfile ? "已开启" : "已关闭"}
                        </button>
                      </div>
                    ) : null}
                    {integrations.isLoading ? (
                      <LoadingRows count={2} />
                    ) : integrations.data ? (
                      <div className="atm-integration-list">
                        {integrations.data.map((report) => {
                          const overall = integrationState(report);
                          const primaryAction: AgentIntegrationAction =
                            overall === "MODIFIED"
                              ? "REPAIR"
                              : overall === "NEEDS_UPDATE"
                                ? "UPDATE"
                                : "INSTALL";
                          const primaryLabel =
                            primaryAction === "REPAIR"
                              ? "修复"
                              : primaryAction === "UPDATE"
                                ? "更新"
                                : "安装";
                          const cliUnavailable =
                            report.client === "CLAUDE_CODE" && !report.cliAvailable;
                          const installNeedsCli = cliUnavailable && !report.mcpInstalled;
                          return (
                            <article className="atm-integration-card" key={report.client}>
                              <header>
                                <strong>{agentClientLabel(report.client)}</strong>
                                <AgentIntegrationBadge state={overall} />
                              </header>
                              <div className="atm-integration-checks">
                                <span>MCP</span>
                                <AgentIntegrationBadge
                                  state={report.mcpInstalled ? "INSTALLED" : "NOT_INSTALLED"}
                                />
                                {report.sharesRuleAndSkillsWith ? (
                                  <>
                                    <span>规则/技能</span>
                                    <span className="atm-row-sub">与 Claude Desktop 共用</span>
                                  </>
                                ) : (
                                  <>
                                    <span>全局 ATM 规则</span>
                                    <AgentIntegrationBadge state={report.rule.state} />
                                    {report.skills.skills.map((skill) => (
                                      <Fragment key={skill.name}>
                                        <span>{skill.name}</span>
                                        <AgentIntegrationBadge state={skill.state} />
                                      </Fragment>
                                    ))}
                                  </>
                                )}
                                {cliUnavailable ? (
                                  <>
                                    <span>CLI</span>
                                    <span className="atm-row-sub">未检测到，安装/卸载不可用</span>
                                  </>
                                ) : null}
                              </div>
                              {report.repairError ? (
                                <div className="atm-inline-error" role="alert">
                                  自动修复失败：{report.repairError}
                                </div>
                              ) : null}
                              <div className="atm-actions">
                                <button
                                  className="atm-button"
                                  disabled={manageIntegration.isPending}
                                  onClick={() =>
                                    manageIntegration.mutate({
                                      client: report.client,
                                      action: "PREVIEW",
                                    })
                                  }
                                >
                                  预览修改
                                </button>
                                {overall !== "INSTALLED" ? (
                                  <button
                                    className="atm-button primary"
                                    disabled={manageIntegration.isPending || installNeedsCli}
                                    onClick={() =>
                                      manageIntegration.mutate({
                                        client: report.client,
                                        action: primaryAction,
                                      })
                                    }
                                  >
                                    {primaryLabel}
                                  </button>
                                ) : null}
                                {overall !== "NOT_INSTALLED" ? (
                                  <button
                                    className="atm-button danger"
                                    disabled={manageIntegration.isPending || cliUnavailable}
                                    onClick={() =>
                                      manageIntegration.mutate({
                                        client: report.client,
                                        action: "UNINSTALL",
                                      })
                                    }
                                  >
                                    卸载 ATM 接入
                                  </button>
                                ) : null}
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    ) : null}
                    {integrationPreview ? (
                      <details className="atm-integration-preview" open>
                        <summary>
                          {agentClientLabel(integrationPreview.client)} 规则修改预览
                        </summary>
                        <pre>{integrationPreview.proposed}</pre>
                      </details>
                    ) : null}
                    <div className="atm-actions">
                      <button
                        className="atm-button"
                        onClick={() =>
                          void copy(configs.data!.streamableHttp, "Streamable HTTP 配置")
                        }
                      >
                        复制 Streamable HTTP
                      </button>
                      <button
                        className="atm-button"
                        onClick={() => void copy(configs.data!.stdio, "stdio 配置")}
                      >
                        复制 stdio
                      </button>
                      <button
                        className="atm-button"
                        onClick={() => void copy(configs.data!.generic, "通用 MCP 配置")}
                      >
                        生成通用配置
                      </button>
                      <button
                        className="atm-button"
                        onClick={async () => {
                          await client.status();
                          setFeedback("连接测试通过");
                        }}
                      >
                        运行连接测试
                      </button>
                    </div>
                    <button
                      className="atm-button"
                      onClick={() => void copy(configs.data!.agentRule, "Agent 最短规则")}
                    >
                      复制 Agent 最短规则
                    </button>
                  </>
                )}
              </>
            ) : (
              <Empty title="浏览器预览模式" text="Agent 自动安装仅在桌面应用内可用。" />
            )}
            {manageIntegration.error ? (
              <div className="atm-inline-error">
                {manageIntegration.error instanceof Error
                  ? manageIntegration.error.message
                  : String(manageIntegration.error)}
              </div>
            ) : null}
          </div>
        </section>
        {desktop?.getMcpBridges ? <McpBridgePanel load={desktop.getMcpBridges} /> : null}
        <section className="atm-panel">
          <div className="atm-panel-head">
            <h2>维护与 Windows</h2>
          </div>
          <div className="atm-panel-body atm-form">
            <label className="atm-check">
              <input
                type="checkbox"
                checked={dailyEnabled}
                onChange={(event) => setDailyEnabled(event.target.checked)}
              />
              <span>每日首次空闲时自动备份活动项目</span>
            </label>
            <div className="atm-form-grid">
              <div className="atm-field">
                <label htmlFor="daily-keep">每日备份保留数</label>
                <input
                  id="daily-keep"
                  type="number"
                  min="1"
                  max="90"
                  value={dailyKeep}
                  onChange={(event) => setDailyKeep(Number(event.target.value))}
                />
              </div>
              <div className="atm-field">
                <label htmlFor="weekly-keep">每周备份保留数</label>
                <input
                  id="weekly-keep"
                  type="number"
                  min="1"
                  max="52"
                  value={weeklyKeep}
                  onChange={(event) => setWeeklyKeep(Number(event.target.value))}
                />
              </div>
            </div>
            <div className="atm-notification-policy">
              <div className="atm-row-title">系统通知</div>
              <div className="atm-notification-options" role="radiogroup" aria-label="系统通知级别">
                {(
                  [
                    ["ALL", "全部通知", "等待、阻塞、完成、异常退出和维护失败"],
                    ["CRITICAL", "仅严重事件", "阻塞、Agent 异常退出和维护失败"],
                    ["OFF", "不通知", "保持后台运行，不弹出系统通知"],
                  ] as const
                ).map(([value, label, description]) => {
                  const selected = notificationMode === value;
                  return (
                    <button
                      className="atm-notification-option"
                      data-selected={selected ? "true" : "false"}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setNotificationMode(value)}
                      key={value}
                    >
                      <span className="atm-notification-radio" aria-hidden="true">
                        {selected ? <CheckCircle size={17} weight="fill" /> : null}
                      </span>
                      <span>
                        <strong>{label}</strong>
                        <small>{description}</small>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
            {desktop?.setAutoLaunch ? (
              <div className="atm-row">
                <div>
                  <div className="atm-row-title">登录时启动</div>
                  <div className="atm-row-sub">登录后随机延迟 8–45 秒启动，并常驻托盘</div>
                </div>
                <button
                  className="atm-button"
                  disabled={autoLaunch === null}
                  onClick={async () => setAutoLaunch(await desktop.setAutoLaunch!(!autoLaunch))}
                >
                  {autoLaunch ? "已开启" : "已关闭"}
                </button>
              </div>
            ) : null}
            {desktop?.getUpdateStatus ? (
              <div className="atm-row" data-testid="update-diagnostics">
                <div>
                  <div className="atm-row-title">自动更新</div>
                  <div className="atm-row-sub">
                    {updateStatus.isLoading
                      ? "正在读取最近结果…"
                      : updateStatus.data
                        ? `${updateStatus.data.message} · ${formatTime(updateStatus.data.at)}${
                            updateStatus.data.outcome === "ERROR"
                              ? `；${updateStatus.data.action}`
                              : ""
                          }`
                        : "尚无更新检查记录"}
                  </div>
                </div>
                <div className="atm-actions">
                  {updateStatus.data ? (
                    <span
                      className={`atm-badge ${
                        updateStatus.data.outcome === "ERROR"
                          ? "danger"
                          : updateStatus.data.outcome === "SUCCESS"
                            ? "success"
                            : updateStatus.data.outcome === "IN_PROGRESS"
                              ? "primary"
                              : ""
                      }`}
                    >
                      {updateStatus.data.outcome === "ERROR"
                        ? "失败"
                        : updateStatus.data.outcome === "SUCCESS"
                          ? "已完成"
                          : updateStatus.data.outcome === "IN_PROGRESS"
                            ? "检查中"
                            : "无更新"}
                    </span>
                  ) : null}
                  {desktop.checkForUpdates ? (
                    <button
                      className="atm-button"
                      disabled={checkUpdate.isPending}
                      onClick={() => checkUpdate.mutate()}
                    >
                      立即检查
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
            <button
              className="atm-button primary"
              disabled={savePolicy.isPending || settings.isLoading}
              onClick={() => savePolicy.mutate()}
            >
              保存设置
            </button>
            {savePolicy.error ? (
              <div className="atm-inline-error">
                {savePolicy.error instanceof Error
                  ? savePolicy.error.message
                  : String(savePolicy.error)}
              </div>
            ) : null}
          </div>
        </section>
      </div>
      {feedback ? (
        <div className="atm-notice" role="status">
          {feedback}
        </div>
      ) : null}
    </>
  );
}

function TaskDrawer({
  client,
  project,
  taskKey,
  close,
  notify,
}: {
  client: AyanamiClient;
  project: string;
  taskKey: string;
  close: () => void;
  notify: Notify;
}) {
  const queryClient = useQueryClient();
  const dialogRef = useDialogAccessibility(close);
  // 正在为哪个检查项补证据；null 表示没有展开的输入框。
  const [evidenceDraft, setEvidenceDraft] = useState<{ id: string; text: string } | null>(null);
  const query = useQuery({
    queryKey: ["task", project, taskKey],
    queryFn: () => client.tasks.get(project, taskKey, "context"),
  });
  const engineering = useQuery({
    queryKey: ["engineering-metrics", project, taskKey],
    queryFn: () => client.projects.engineeringMetrics(project, taskKey),
  });
  const patch = useMutation({
    mutationFn: async (input: Record<string, unknown>) =>
      client.tasks.patchAsUser(project, {
        opId: `ui-patch-${crypto.randomUUID()}`,
        items: [{ taskKey, expectedVersion: Number(query.data!.version), ...input }],
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tasks", project] }),
        queryClient.invalidateQueries({ queryKey: ["task", project, taskKey] }),
        queryClient.invalidateQueries({ queryKey: ["reconciliation", project] }),
        queryClient.invalidateQueries({ queryKey: ["brief", project] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
      ]);
      notify("任务状态已更新");
    },
  });
  const check = useMutation({
    mutationFn: async (input: {
      item: any;
      status: "TODO" | "DONE" | "SKIPPED";
      evidence?: unknown[];
    }) =>
      client.tasks.checklistAsUser(project, input.item.id, {
        opId: `ui-check-${crypto.randomUUID()}`,
        checklistId: input.item.id,
        expectedVersion: input.item.version,
        status: input.status,
        evidence: input.evidence ?? input.item.evidence ?? [],
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["task", project, taskKey] }),
        queryClient.invalidateQueries({ queryKey: ["tasks", project] }),
        queryClient.invalidateQueries({ queryKey: ["reconciliation", project] }),
        queryClient.invalidateQueries({ queryKey: ["brief", project] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
      ]);
      setEvidenceDraft(null);
    },
    // 失败必须可见：证据闸门是最常见的拒绝原因，静默会让人以为勾选框坏了。
    onError: (error) =>
      notify(`检查项更新失败：${error instanceof Error ? error.message : String(error)}`),
  });
  const actions = (status: string, stale: boolean): Array<[string, string]> => {
    if (["BACKLOG", "READY"].includes(status))
      return [
        ["start", "开始"],
        ["cancel", "取消"],
      ];
    if (status === "CLAIMED")
      return stale
        ? [
            ["release", "释放过期领取"],
            ["cancel", "取消"],
          ]
        : [["cancel", "取消"]];
    if (status === "IN_PROGRESS")
      return stale
        ? [
            ["release", "释放过期领取"],
            ["verify", "提交验收"],
            ["block", "阻塞"],
            ["wait_user", "等待用户"],
            ["wait_agent", "等待 Agent"],
            ["cancel", "取消"],
          ]
        : [
            ["verify", "提交验收"],
            ["block", "阻塞"],
            ["wait_user", "等待用户"],
            ["wait_agent", "等待 Agent"],
            ["cancel", "取消"],
          ];
    if (["BLOCKED", "WAITING_USER", "WAITING_AGENT"].includes(status))
      return [
        ["reopen", "重新打开"],
        ["cancel", "取消"],
      ];
    if (status === "VERIFYING")
      return [
        ["complete", "完成"],
        ["reopen", "退回"],
      ];
    if (["DONE", "CANCELLED"].includes(status)) return [["reopen", "重新打开"]];
    return [];
  };
  const runAction = (operation: string) => {
    const input: Record<string, unknown> = { operation };
    if (operation === "block") {
      const reason = window.prompt("请填写阻塞原因");
      if (!reason?.trim()) return;
      input.blockedReason = reason.trim();
    }
    if (operation === "wait_user" || operation === "wait_agent") {
      const waitingFor = window.prompt(
        operation === "wait_user" ? "请填写等待用户提供的内容" : "请填写等待 Agent 完成的内容",
      );
      if (!waitingFor?.trim()) return;
      input.waitingFor = waitingFor.trim();
    }
    if (operation === "cancel" && !window.confirm("确认取消这个任务？")) return;
    patch.mutate(input);
  };
  const progress = query.data ? taskProgressPresentation(query.data) : null;
  return (
    <div className="atm-drawer-backdrop" role="presentation" onMouseDown={close}>
      <aside
        ref={dialogRef}
        className="atm-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="任务详情"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="atm-drawer-head">
          <button
            type="button"
            className="atm-drawer-collapse"
            onClick={close}
            aria-label="收起任务详情"
            title="收起任务详情"
          >
            <CaretRight size={18} weight="bold" aria-hidden="true" />
          </button>
          <div>
            {query.data ? (
              <>
                <span className="atm-key">{taskKey}</span>
                <h2 style={{ margin: "6px 0 0", fontSize: 19 }}>{String(query.data.title)}</h2>
              </>
            ) : (
              <span>载入任务</span>
            )}
          </div>
        </header>
        {query.isLoading ? (
          <LoadingRows />
        ) : query.error ? (
          <ErrorState error={query.error} />
        ) : (
          <div className="atm-drawer-body">
            <div className="atm-actions">
              <Status value={String(query.data!.status)} />
              {progress && progress.phaseLabel !== String(query.data!.status) ? (
                <span className="atm-badge">{progress.phaseLabel}</span>
              ) : null}
              {actions(
                String(query.data!.status),
                Boolean(
                  query.data!.claimLeaseUntil &&
                    Date.parse(String(query.data!.claimLeaseUntil)) <= Date.now(),
                ),
              ).map(([operation, label]) => (
                <button
                  className={`atm-button ${["start", "verify", "complete"].includes(operation) ? "primary" : operation === "cancel" ? "danger" : ""}`}
                  disabled={patch.isPending}
                  key={operation}
                  onClick={() => runAction(operation)}
                >
                  {label}
                </button>
              ))}
            </div>
            {patch.error ? (
              <div className="atm-inline-error">
                {patch.error instanceof Error ? patch.error.message : String(patch.error)}
              </div>
            ) : null}
            <section className="atm-section">
              <h3>说明</h3>
              <div className="atm-description">
                {String(query.data!.description || "尚未填写说明")}
              </div>
            </section>
            <section className="atm-section">
              <h3>进度</h3>
              <div className="atm-progress">
                <span style={{ width: `${progress!.computed}%` }} />
              </div>
              <div className="atm-row-sub">
                派生 {Math.round(progress!.computed)}% ·{" "}
                {progressSourceLabels[progress!.source] ?? "状态计算"}
                {progress!.totalStages
                  ? ` · ${progress!.doneStages}/${progress!.totalStages} 阶段 · 权重 ${progress!.doneWeight}/${progress!.totalWeight}`
                  : ""}
              </div>
              {progress!.reported !== null && progress!.reported !== progress!.computed ? (
                <div className="atm-row-sub">Agent 报告：{Math.round(progress!.reported)}%</div>
              ) : null}
              {progress!.blocker ? (
                <div className="atm-inline-error">当前门禁：{progress!.blocker}</div>
              ) : null}
            </section>
            <section className="atm-section">
              <h3>验收标准</h3>
              {(query.data!.acceptance as string[]).length ? (
                (query.data!.acceptance as string[]).map((item) => (
                  <div className="atm-check" key={item}>
                    <CheckCircle size={17} color="var(--atm-success)" />
                    <span>{item}</span>
                  </div>
                ))
              ) : (
                <div className="atm-row-sub">未设置验收标准</div>
              )}
            </section>
            <section className="atm-section">
              <h3>检查项</h3>
              {(query.data!.checklist as any[]).length ? (
                (query.data!.checklist as any[]).map((item) => {
                  const evidence: unknown[] = item.evidence ?? [];
                  const draft = evidenceDraft?.id === item.id ? evidenceDraft : null;
                  return (
                    <div className="atm-checkline" key={item.id}>
                      <label className="atm-check">
                        <input
                          type="checkbox"
                          checked={item.status === "DONE"}
                          disabled={check.isPending}
                          onChange={() => {
                            const intent = checklistToggleIntent(item);
                            if (intent.action === "request-evidence") {
                              setEvidenceDraft({ id: item.id, text: "" });
                              return;
                            }
                            check.mutate({ item, status: intent.status });
                          }}
                        />
                        <span>
                          {item.title}
                          {item.evidenceRequired ? (
                            <span className="atm-row-sub"> · 需要证据</span>
                          ) : null}
                          {item.status === "SKIPPED" ? (
                            <span className="atm-row-sub"> · 已跳过</span>
                          ) : null}
                        </span>
                      </label>
                      {evidence.length ? (
                        <ul className="atm-evidence">
                          {evidence.map((entry, index) => (
                            <li key={index}>{evidenceText(entry)}</li>
                          ))}
                        </ul>
                      ) : null}
                      {draft ? (
                        <div className="atm-field atm-evidence-form">
                          <label htmlFor={`evidence-${item.id}`}>证据</label>
                          <textarea
                            id={`evidence-${item.id}`}
                            value={draft.text}
                            autoFocus
                            placeholder="例如：packaged smoke 11/11，或 commit ab06501"
                            onChange={(event) =>
                              setEvidenceDraft({ id: item.id, text: event.target.value })
                            }
                          />
                          <div className="atm-actions">
                            <button
                              className="atm-button"
                              type="button"
                              disabled={!draft.text.trim() || check.isPending}
                              onClick={() =>
                                check.mutate({
                                  item,
                                  status: "DONE",
                                  evidence: [...evidence, draft.text.trim()],
                                })
                              }
                            >
                              附上并完成
                            </button>
                            <button
                              className="atm-button"
                              type="button"
                              onClick={() => setEvidenceDraft(null)}
                            >
                              取消
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="atm-actions atm-evidence-actions">
                          <button
                            className="atm-button"
                            type="button"
                            disabled={check.isPending}
                            onClick={() => setEvidenceDraft({ id: item.id, text: "" })}
                          >
                            添加证据
                          </button>
                          {item.status === "SKIPPED" ? (
                            <button
                              className="atm-button"
                              type="button"
                              disabled={check.isPending}
                              onClick={() => check.mutate({ item, status: "TODO" })}
                            >
                              恢复
                            </button>
                          ) : (
                            <button
                              className="atm-button"
                              type="button"
                              disabled={check.isPending}
                              onClick={() => check.mutate({ item, status: "SKIPPED" })}
                            >
                              跳过
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              ) : (
                <div className="atm-row-sub">未设置检查项</div>
              )}
            </section>
            <section className="atm-section">
              <h3>依赖</h3>
              <div className="atm-actions">
                {(query.data!.dependencies as string[]).length ? (
                  (query.data!.dependencies as string[]).map((key) => (
                    <span className="atm-badge" key={key}>
                      {key}
                    </span>
                  ))
                ) : (
                  <span className="atm-row-sub">没有前置依赖</span>
                )}
              </div>
            </section>
            <section className="atm-section">
              <h3>工作中发现</h3>
              <div className="atm-actions">
                {query.data!.discoveredFrom ? (
                  <span className="atm-badge primary">
                    来源 {String(query.data!.discoveredFrom)}
                  </span>
                ) : null}
                {(query.data!.discovered as string[]).map((key) => (
                  <span className="atm-badge" key={key}>
                    发现 {key}
                  </span>
                ))}
                {!query.data!.discoveredFrom && !(query.data!.discovered as string[]).length ? (
                  <span className="atm-row-sub">没有发现关系</span>
                ) : null}
              </div>
            </section>
            {query.data!.executionSession ? (
              <section className="atm-section">
                <h3>执行 Session</h3>
                <div className="atm-row-title">
                  {String((query.data!.executionSession as any).display_name)} ·{" "}
                  {statusLabels[String((query.data!.executionSession as any).role)] ??
                    String((query.data!.executionSession as any).role)}
                </div>
                <div className="atm-row-sub">
                  Branch：{String((query.data!.executionSession as any).git_branch || "不可用")}
                </div>
                <div
                  className="atm-row-sub"
                  title={String((query.data!.executionSession as any).worktree_root || "")}
                >
                  Worktree：{compactPath((query.data!.executionSession as any).worktree_root)}
                </div>
                <div className="atm-row-sub">
                  HEAD：
                  {String((query.data!.executionSession as any).git_head || "不可用").slice(0, 10)}
                  {Number((query.data!.executionSession as any).git_dirty) === 1
                    ? " · dirty"
                    : " · clean"}
                </div>
              </section>
            ) : null}
            {engineering.data?.available && engineering.data.workItem?.metrics ? (
              <section className="atm-section">
                <h3>工程变更</h3>
                <div className="atm-engineering-kpis compact">
                  <div>
                    <span>修改</span>
                    <strong>{engineering.data.workItem.metrics.filesChanged}</strong>
                  </div>
                  <div>
                    <span>新建</span>
                    <strong>{engineering.data.workItem.metrics.filesCreated}</strong>
                  </div>
                  <div>
                    <span>删除</span>
                    <strong>{engineering.data.workItem.metrics.filesDeleted}</strong>
                  </div>
                  <div>
                    <span>新增行</span>
                    <strong>+{engineering.data.workItem.metrics.linesAdded}</strong>
                  </div>
                  <div>
                    <span>删除行</span>
                    <strong>-{engineering.data.workItem.metrics.linesDeleted}</strong>
                  </div>
                  <div>
                    <span>净行数</span>
                    <strong>{engineering.data.workItem.metrics.netLines}</strong>
                  </div>
                  <div>
                    <span>Source +</span>
                    <strong>{engineering.data.workItem.metrics.sourceLinesAdded}</strong>
                  </div>
                  <div>
                    <span>Test +</span>
                    <strong>{engineering.data.workItem.metrics.testLinesAdded}</strong>
                  </div>
                </div>
                <div className="atm-row-sub">
                  新增依赖：
                  {(engineering.data.workItem.metrics.dependenciesAdded as string[]).join("、") ||
                    "无"}
                </div>
              </section>
            ) : null}
          </div>
        )}
      </aside>
    </div>
  );
}

function CreateTaskModal({
  client,
  project,
  close,
  notify,
}: {
  client: AyanamiClient;
  project: string;
  close: () => void;
  notify: Notify;
}) {
  const queryClient = useQueryClient();
  const dialogRef = useDialogAccessibility(close);
  const context = useQuery({
    queryKey: ["objectives", project],
    queryFn: () => client.projects.objectives(project),
  });
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("NORMAL");
  const [acceptance, setAcceptance] = useState("");
  const mutation = useMutation({
    mutationFn: async () => {
      const objective = context.data?.find((item) => item.status === "ACTIVE") ?? context.data?.[0];
      if (!objective) throw new Error("请先为项目创建活动目标");
      return client.tasks.createAsUser(project, {
        opId: `ui-create-${crypto.randomUUID()}`,
        items: [
          {
            clientRef: "ui-task",
            objectiveId: objective.id,
            title,
            description,
            type: "TASK",
            priority,
            status: "READY",
            acceptance: acceptance
              .split(/\r?\n/u)
              .map((item) => item.trim())
              .filter(Boolean),
            checklist: [],
            dependsOn: [],
            dependsOnRefs: [],
            weight: 1,
            verificationRequired: false,
          },
        ],
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tasks", project] }),
        queryClient.invalidateQueries({ queryKey: ["reconciliation", project] }),
        queryClient.invalidateQueries({ queryKey: ["brief", project] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
      ]);
      notify("任务已创建");
      close();
    },
  });
  return (
    <div className="atm-modal-backdrop">
      <section
        ref={dialogRef}
        className="atm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-task-title"
        tabIndex={-1}
      >
        <header className="atm-modal-head">
          <h2 id="create-task-title">新建任务</h2>
          <button className="atm-button atm-icon-button" onClick={close} aria-label="关闭">
            <X size={17} />
          </button>
        </header>
        <div className="atm-modal-body">
          <div className="atm-form">
            <div className="atm-field">
              <label htmlFor="task-title">标题</label>
              <input
                id="task-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                data-dialog-autofocus
              />
            </div>
            <div className="atm-field">
              <label htmlFor="task-description">说明</label>
              <textarea
                id="task-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="atm-field">
              <label htmlFor="task-priority">优先级</label>
              <AtmSelect
                id="task-priority"
                ariaLabel="优先级"
                value={priority}
                options={[
                  { value: "LOW", label: "低" },
                  { value: "NORMAL", label: "普通" },
                  { value: "HIGH", label: "高" },
                  { value: "CRITICAL", label: "紧急" },
                ]}
                onChange={setPriority}
              />
            </div>
            <div className="atm-field">
              <label htmlFor="task-acceptance">验收标准</label>
              <textarea
                id="task-acceptance"
                value={acceptance}
                onChange={(e) => setAcceptance(e.target.value)}
                placeholder="每行一条"
              />
            </div>
            {mutation.error ? (
              <div className="atm-inline-error">
                {mutation.error instanceof Error ? mutation.error.message : String(mutation.error)}
              </div>
            ) : null}
          </div>
        </div>
        <footer className="atm-modal-foot">
          <button className="atm-button" onClick={close}>
            取消
          </button>
          <button
            className="atm-button primary"
            disabled={!title.trim() || mutation.isPending || context.isLoading}
            onClick={() => mutation.mutate()}
          >
            创建任务
          </button>
        </footer>
      </section>
    </div>
  );
}

function CreateRecordModal({
  client,
  project,
  close,
  notify,
}: {
  client: AyanamiClient;
  project: string;
  close: () => void;
  notify: Notify;
}) {
  const queryClient = useQueryClient();
  const dialogRef = useDialogAccessibility(close);
  const [kind, setKind] = useState<UserRecordCreateInput["kind"]>("DECISION");
  const [importance, setImportance] =
    useState<NonNullable<UserRecordCreateInput["importance"]>>("NORMAL");
  const [topic, setTopic] = useState("");
  const [subjectKey, setSubjectKey] = useState("");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [detail, setDetail] = useState("");
  const mutation = useMutation({
    mutationFn: () =>
      client.recordAsUser(
        project,
        recordDraftToUserInput({
          opId: `ui-record-${crypto.randomUUID()}`,
          kind,
          importance,
          title,
          summary,
          detail,
          topic,
          subjectKey,
        }),
      ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["records", project] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
      ]);
      notify("项目记录已保存");
      close();
    },
  });
  return (
    <div className="atm-modal-backdrop">
      <section
        ref={dialogRef}
        className="atm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="record-modal-title"
        tabIndex={-1}
      >
        <header className="atm-modal-head">
          <h2 id="record-modal-title">新建项目记录</h2>
          <button className="atm-button atm-icon-button" onClick={close} aria-label="关闭">
            <X size={17} />
          </button>
        </header>
        <div className="atm-modal-body atm-form">
          <div className="atm-form-grid">
            <div className="atm-field">
              <label htmlFor="record-kind">类型</label>
              <AtmSelect
                id="record-kind"
                ariaLabel="记录类型"
                value={kind}
                options={[
                  { value: "DECISION", label: "决策" },
                  { value: "CONSTRAINT", label: "约束" },
                  { value: "FACT", label: "事实" },
                  { value: "RISK", label: "风险" },
                  { value: "REFERENCE", label: "参考" },
                  { value: "LESSON", label: "经验" },
                  { value: "VERIFICATION", label: "验证" },
                  { value: "WAIVER", label: "豁免" },
                ]}
                onChange={(value) => setKind(value as UserRecordCreateInput["kind"])}
              />
            </div>
            <div className="atm-field">
              <label htmlFor="record-importance">重要性</label>
              <AtmSelect
                id="record-importance"
                ariaLabel="记录重要性"
                value={importance}
                options={[
                  { value: "LOW", label: "低" },
                  { value: "NORMAL", label: "普通" },
                  { value: "HIGH", label: "高" },
                  { value: "CRITICAL", label: "紧急" },
                ]}
                onChange={(value) =>
                  setImportance(value as NonNullable<UserRecordCreateInput["importance"]>)
                }
              />
            </div>
          </div>
          <div className="atm-field">
            <label htmlFor="record-topic">主题（可选，用于发现相关记录）</label>
            <input
              id="record-topic"
              value={topic}
              maxLength={200}
              placeholder="例如：release/1.0.16 或 review/candidate-a"
              onChange={(event) => setTopic(event.target.value)}
            />
          </div>
          <div className="atm-field">
            <label htmlFor="record-subject-key">主题标识（可选）</label>
            <input
              id="record-subject-key"
              value={subjectKey}
              maxLength={200}
              placeholder="例如：candidate:release-v1"
              onChange={(event) => setSubjectKey(event.target.value)}
            />
          </div>
          <div className="atm-field">
            <label htmlFor="record-title">标题</label>
            <input
              id="record-title"
              data-dialog-autofocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="atm-field">
            <label htmlFor="record-summary">摘要</label>
            <textarea
              id="record-summary"
              maxLength={300}
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
            />
          </div>
          <div className="atm-field">
            <label htmlFor="record-detail">详细内容</label>
            <textarea
              id="record-detail"
              value={detail}
              onChange={(event) => setDetail(event.target.value)}
            />
          </div>
          {mutation.error ? (
            <div className="atm-inline-error">
              {mutation.error instanceof Error ? mutation.error.message : String(mutation.error)}
            </div>
          ) : null}
        </div>
        <footer className="atm-modal-foot">
          <button className="atm-button" onClick={close}>
            取消
          </button>
          <button
            className="atm-button primary"
            disabled={!title.trim() || !summary.trim() || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            保存记录
          </button>
        </footer>
      </section>
    </div>
  );
}

function ProjectUpdateModal({
  client,
  project,
  close,
  notify,
}: {
  client: AyanamiClient;
  project: string;
  close: () => void;
  notify: Notify;
}) {
  const queryClient = useQueryClient();
  const dialogRef = useDialogAccessibility(close);
  const history = useQuery({
    queryKey: ["project-updates", project],
    queryFn: () => client.projects.updates(project),
  });
  const [draft, setDraft] = useState<Record<string, any> | null>(null);
  const [health, setHealth] = useState("UNKNOWN");
  const [summary, setSummary] = useState("");
  const generate = useMutation({
    mutationFn: () => client.projects.draftUpdate(project, `ui-draft-${crypto.randomUUID()}`),
    onSuccess: (value) => {
      setDraft(value);
      setHealth(String(value.health));
      setSummary(String(value.summary));
    },
  });
  const publish = useMutation({
    mutationFn: () =>
      client.projects.publishUpdate(project, {
        opId: `ui-publish-${crypto.randomUUID()}`,
        draftId: draft?.id,
        health,
        summary,
        completed: draft?.completed ?? [],
        risks: draft?.risks ?? [],
        next: draft?.next ?? [],
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["project-updates", project] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
        queryClient.invalidateQueries({ queryKey: ["brief", project] }),
      ]);
      notify("项目更新已发布");
      close();
    },
  });
  const error = generate.error ?? publish.error;
  return (
    <div className="atm-modal-backdrop">
      <section
        ref={dialogRef}
        className="atm-modal wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-update-title"
        tabIndex={-1}
      >
        <header className="atm-modal-head">
          <h2 id="project-update-title">发布项目更新</h2>
          <button className="atm-button atm-icon-button" onClick={close} aria-label="关闭">
            <X size={17} />
          </button>
        </header>
        <div className="atm-modal-body atm-form">
          {!draft ? (
            <section className="atm-panel">
              <Empty
                title="生成确定性草稿"
                text="系统根据上次发布后的完成项、当前风险和下一批活动任务生成草稿。"
                action={
                  <button
                    className="atm-button primary"
                    disabled={generate.isPending}
                    onClick={() => generate.mutate()}
                  >
                    {generate.isPending ? "正在生成" : "生成更新草稿"}
                  </button>
                }
              />
            </section>
          ) : (
            <>
              <div className="atm-field">
                <label htmlFor="project-health">项目健康度</label>
                <AtmSelect
                  id="project-health"
                  ariaLabel="项目健康度"
                  value={health}
                  options={[
                    { value: "UNKNOWN", label: "未知" },
                    { value: "ON_TRACK", label: "正常" },
                    { value: "AT_RISK", label: "有风险" },
                    { value: "OFF_TRACK", label: "偏离计划" },
                  ]}
                  onChange={setHealth}
                />
              </div>
              <div className="atm-field">
                <label htmlFor="project-update-summary">当前判断</label>
                <textarea
                  id="project-update-summary"
                  value={summary}
                  onChange={(event) => setSummary(event.target.value)}
                />
              </div>
              <div className="atm-form-grid">
                <div className="atm-panel-body">
                  <strong>已完成</strong>
                  {(draft.completed as string[]).length ? (
                    (draft.completed as string[]).map((item) => (
                      <div className="atm-row-sub" key={item}>
                        · {item}
                      </div>
                    ))
                  ) : (
                    <div className="atm-row-sub">暂无新增完成项</div>
                  )}
                </div>
                <div className="atm-panel-body">
                  <strong>风险</strong>
                  {(draft.risks as string[]).length ? (
                    (draft.risks as string[]).map((item) => (
                      <div className="atm-row-sub" key={item}>
                        · {item}
                      </div>
                    ))
                  ) : (
                    <div className="atm-row-sub">当前无阻塞风险</div>
                  )}
                </div>
              </div>
              <div className="atm-panel-body">
                <strong>下一步</strong>
                {(draft.next as string[]).map((item) => (
                  <div className="atm-row-sub" key={item}>
                    · {item}
                  </div>
                ))}
              </div>
            </>
          )}
          {history.data?.some((item) => item.status === "PUBLISHED") ? (
            <section className="atm-section">
              <h3>最近发布</h3>
              {history.data
                .filter((item) => item.status === "PUBLISHED")
                .slice(0, 3)
                .map((item) => (
                  <div className="atm-row" key={item.id}>
                    <div>
                      <div className="atm-row-title">{item.summary}</div>
                      <div className="atm-row-sub">
                        {formatTime(item.publishedAt)} · {statusLabels[item.health] ?? item.health}
                      </div>
                    </div>
                  </div>
                ))}
            </section>
          ) : null}
          {error ? (
            <div className="atm-inline-error">
              {error instanceof Error ? error.message : String(error)}
            </div>
          ) : null}
        </div>
        <footer className="atm-modal-foot">
          <button className="atm-button" onClick={close}>
            取消
          </button>
          {draft ? (
            <button
              className="atm-button primary"
              disabled={!summary.trim() || publish.isPending}
              onClick={() => publish.mutate()}
            >
              发布更新
            </button>
          ) : null}
        </footer>
      </section>
    </div>
  );
}

function ProjectDataModal({
  client,
  project,
  close,
  notify,
}: {
  client: AyanamiClient;
  project: string;
  close: () => void;
  notify: Notify;
}) {
  const queryClient = useQueryClient();
  const dialogRef = useDialogAccessibility(close);
  const backups = useQuery({
    queryKey: ["backups", project],
    queryFn: () => client.backups.list(project),
  });
  const [source, setSource] = useState<{ name: string; content: string } | null>(null);
  const [preview, setPreview] = useState<Record<string, any> | null>(null);
  const createBackup = useMutation({
    mutationFn: () => client.backups.create(project),
    onSuccess: async () => {
      await backups.refetch();
      notify("项目备份已创建并校验");
    },
  });
  const restore = useMutation({
    mutationFn: (id: string) => client.backups.restore(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      notify("项目已从备份恢复");
    },
  });
  const exportData = useMutation({
    mutationFn: (format: "aytproj" | "json" | "csv") => client.data.exportProject(project, format),
    onSuccess: (result) => notify(`导出完成：${String(result.path)}`),
  });
  const previewImport = useMutation({
    mutationFn: async () => {
      if (!source) throw new Error("请先选择 agenttask.md");
      return client.data.previewAgentTask({
        project,
        content: source.content,
        sourceName: source.name,
      });
    },
    onSuccess: setPreview,
  });
  const applyImport = useMutation({
    mutationFn: async () => {
      if (!source || !preview) throw new Error("请先生成导入预览");
      return client.data.applyAgentTask({
        project,
        content: source.content,
        sourceName: source.name,
        expectedSha256: preview.sha256,
      });
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries();
      notify(result.alreadyImported ? "该文件已经导入过" : "旧任务账本已导入");
    },
  });
  const busyError =
    createBackup.error ??
    restore.error ??
    exportData.error ??
    previewImport.error ??
    applyImport.error;
  return (
    <div className="atm-modal-backdrop">
      <section
        ref={dialogRef}
        className="atm-modal wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="data-tools-title"
        tabIndex={-1}
      >
        <header className="atm-modal-head">
          <h2 id="data-tools-title">备份、恢复与数据交换</h2>
          <button className="atm-button atm-icon-button" onClick={close} aria-label="关闭">
            <X size={17} />
          </button>
        </header>
        <div className="atm-modal-body atm-form">
          <section className="atm-section">
            <div className="atm-actions" style={{ justifyContent: "space-between" }}>
              <div>
                <h3>项目备份</h3>
                <div className="atm-row-sub">
                  使用 SQLite Online Backup 创建一致性快照，并校验 SHA-256。
                </div>
              </div>
              <button
                className="atm-button primary"
                disabled={createBackup.isPending}
                onClick={() => createBackup.mutate()}
              >
                立即备份
              </button>
            </div>
            <div className="atm-panel" style={{ marginTop: 12 }}>
              {backups.isLoading ? (
                <LoadingRows count={2} />
              ) : backups.data?.length ? (
                <div className="atm-list">
                  {backups.data.slice(0, 8).map((backup) => (
                    <div className="atm-row" key={backup.id}>
                      <div>
                        <div className="atm-row-title">
                          {backup.reason} · {(Number(backup.sizeBytes) / 1024).toFixed(1)} KB
                        </div>
                        <div className="atm-row-sub">
                          {formatTime(backup.createdAt)} · {backup.verifiedAt ? "已验证" : "未验证"}
                        </div>
                      </div>
                      <button
                        className="atm-button danger"
                        disabled={restore.isPending}
                        onClick={() => {
                          if (
                            window.confirm(
                              "恢复会先备份当前项目，然后以所选快照替换项目数据。继续吗？",
                            )
                          )
                            restore.mutate(String(backup.id));
                        }}
                      >
                        恢复
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty title="没有项目备份" text="创建首个手动备份后会显示在这里。" />
              )}
            </div>
          </section>
          <section className="atm-section">
            <h3>导出项目</h3>
            <div className="atm-row-sub" style={{ marginBottom: 10 }}>
              .aytproj 含数据库一致性快照和校验清单；JSON/CSV 用于只读检查。
            </div>
            <div className="atm-actions">
              <button
                className="atm-button"
                disabled={exportData.isPending}
                onClick={() => exportData.mutate("aytproj")}
              >
                导出 .aytproj
              </button>
              <button
                className="atm-button"
                disabled={exportData.isPending}
                onClick={() => exportData.mutate("json")}
              >
                导出 JSON
              </button>
              <button
                className="atm-button"
                disabled={exportData.isPending}
                onClick={() => exportData.mutate("csv")}
              >
                导出 CSV
              </button>
            </div>
          </section>
          <section className="atm-section">
            <h3>导入旧 agenttask.md</h3>
            <div className="atm-field">
              <label htmlFor="agenttask-file">选择 Markdown 文件</label>
              <input
                id="agenttask-file"
                type="file"
                accept=".md,text/markdown,text/plain"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  setPreview(null);
                  setSource(file ? { name: file.name, content: await file.text() } : null);
                }}
              />
            </div>
            <div className="atm-actions" style={{ marginTop: 10 }}>
              <button
                className="atm-button"
                disabled={!source || previewImport.isPending}
                onClick={() => previewImport.mutate()}
              >
                生成预览
              </button>
              {preview ? (
                <button
                  className="atm-button primary"
                  disabled={preview.alreadyImported || applyImport.isPending}
                  onClick={() => applyImport.mutate()}
                >
                  {preview.alreadyImported ? "已经导入" : "确认导入"}
                </button>
              ) : null}
            </div>
            {preview ? (
              <div className="atm-panel-body" style={{ marginTop: 8 }}>
                目标 {preview.objectiveCount} · 里程碑 {preview.milestoneCount} · 任务{" "}
                {preview.taskCount} · 参考记录 {preview.recordCount}
                {(preview.warnings as string[]).map((warning) => (
                  <div className="atm-row-sub" key={warning}>
                    注意：{warning}
                  </div>
                ))}
              </div>
            ) : null}
          </section>
          {busyError ? (
            <div className="atm-inline-error">
              {busyError instanceof Error ? busyError.message : String(busyError)}
            </div>
          ) : null}
        </div>
        <footer className="atm-modal-foot">
          <button className="atm-button" onClick={close}>
            关闭
          </button>
        </footer>
      </section>
    </div>
  );
}

type ProjectTaskFilters = {
  status: string;
  assignee: string;
  milestone: string;
  due: "" | "OVERDUE" | "DATED";
  blockedOnly: boolean;
  progressSource: string;
};

const emptyTaskFilters: ProjectTaskFilters = {
  status: "",
  assignee: "",
  milestone: "",
  due: "",
  blockedOnly: false,
  progressSource: "",
};

function ProjectTaskFilterBar({
  client,
  project,
  tasks,
  value,
  onChange,
  notify,
}: {
  client: AyanamiClient;
  project: string;
  tasks: any[];
  value: ProjectTaskFilters;
  onChange: (value: ProjectTaskFilters) => void;
  notify: Notify;
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState("");
  const views = useQuery({
    queryKey: ["saved-views", project],
    queryFn: () => client.savedViews.list(project),
  });
  const milestones = useQuery({
    queryKey: ["milestones", project],
    queryFn: () => client.projects.milestones(project),
  });
  const create = useMutation({
    mutationFn: (name: string) =>
      client.savedViews.create({
        scope: "PROJECT",
        project,
        name,
        query: value,
        sort: { field: "priority", direction: "desc" },
      }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ["saved-views", project] });
      setSelected(String(created.id));
      notify("已保存当前视图");
    },
  });
  const remove = useMutation({
    mutationFn: (view: any) => client.savedViews.remove(String(view.id), Number(view.version)),
    onSuccess: async () => {
      setSelected("");
      await queryClient.invalidateQueries({ queryKey: ["saved-views", project] });
      notify("已删除保存视图");
    },
  });
  const chosen = views.data?.find((view) => view.id === selected);
  const patch = (next: Partial<ProjectTaskFilters>) => onChange({ ...value, ...next });
  const assignees = [
    ...new Set(
      tasks.map((task) => task.assigneeAgentId).filter((entry): entry is string => Boolean(entry)),
    ),
  ];
  return (
    <div className="atm-filterbar">
      <AtmSelect
        ariaLabel="保存视图"
        value={selected}
        options={[
          { value: "", label: "保存视图" },
          ...(views.data ?? []).map((view) => ({ value: String(view.id), label: view.name })),
        ]}
        onChange={(id) => {
          setSelected(id);
          const view = views.data?.find((candidate) => candidate.id === id);
          if (view)
            onChange({ ...emptyTaskFilters, ...(view.query as Partial<ProjectTaskFilters>) });
        }}
      />
      <AtmSelect
        ariaLabel="状态筛选"
        value={value.status}
        options={[
          { value: "", label: "全部状态" },
          ...Object.entries(statusLabels)
            .filter(([key]) =>
              [
                "BACKLOG",
                "READY",
                "CLAIMED",
                "IN_PROGRESS",
                "BLOCKED",
                "WAITING_USER",
                "WAITING_AGENT",
                "VERIFYING",
                "DONE",
                "CANCELLED",
              ].includes(key),
            )
            .map(([key, label]) => ({ value: key, label })),
        ]}
        onChange={(status) => patch({ status })}
      />
      <AtmSelect
        ariaLabel="Agent 筛选"
        className="wide"
        value={value.assignee}
        options={[
          { value: "", label: "全部负责人" },
          ...assignees.map((agent) => ({
            value: agent,
            label: agent === "USER" ? "桌面用户" : agent,
          })),
        ]}
        onChange={(assignee) => patch({ assignee })}
      />
      <AtmSelect
        ariaLabel="里程碑筛选"
        className="medium"
        value={value.milestone}
        options={[
          { value: "", label: "全部里程碑" },
          ...(milestones.data ?? []).map((milestone) => ({
            value: String(milestone.id),
            label: milestone.title,
          })),
        ]}
        onChange={(milestone) => patch({ milestone })}
      />
      <AtmSelect
        ariaLabel="截止日期筛选"
        value={value.due}
        options={[
          { value: "", label: "全部日期" },
          { value: "OVERDUE", label: "已超期" },
          { value: "DATED", label: "已设目标日" },
        ]}
        onChange={(due) => patch({ due: due as ProjectTaskFilters["due"] })}
      />
      <AtmSelect
        ariaLabel="进度来源筛选"
        className="medium"
        value={value.progressSource}
        options={[
          { value: "", label: "全部进度来源" },
          ...Object.entries(progressSourceLabels).map(([key, label]) => ({ value: key, label })),
        ]}
        onChange={(progressSource) => patch({ progressSource })}
      />
      <label className="atm-filter atm-filter-check">
        <input
          type="checkbox"
          checked={value.blockedOnly}
          onChange={(event) => patch({ blockedOnly: event.target.checked })}
        />
        仅阻塞
      </label>
      <button
        className="atm-button"
        onClick={() => {
          const name = window.prompt("保存视图名称");
          if (name?.trim()) create.mutate(name.trim());
        }}
      >
        保存当前
      </button>
      {chosen ? (
        <button
          className="atm-button danger"
          disabled={remove.isPending}
          onClick={() => remove.mutate(chosen)}
        >
          删除视图
        </button>
      ) : null}
      {Object.values(value).some(Boolean) ? (
        <button
          className="atm-button"
          onClick={() => {
            setSelected("");
            onChange(emptyTaskFilters);
          }}
        >
          清除筛选
        </button>
      ) : null}
    </div>
  );
}

function ProjectTaskSortHeader({
  field,
  label,
  sort,
  onSort,
}: {
  field: ProjectTaskSortField;
  label: string;
  sort: ProjectTaskSort | null;
  onSort: (field: ProjectTaskSortField) => void;
}) {
  const active = sort?.field === field;
  return (
    <th aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : undefined}>
      <button
        className="atm-table-sort"
        data-active={active ? "true" : "false"}
        data-direction={active ? sort.direction : undefined}
        aria-label={`按${label}排序`}
        title={
          active ? `当前${sort.direction === "asc" ? "正序" : "倒序"}，点击切换` : "点击倒序排列"
        }
        onClick={() => onSort(field)}
      >
        <span>{label}</span>
        <CaretDown size={13} weight="bold" aria-hidden="true" />
      </button>
    </th>
  );
}

function ProjectPage({
  client,
  project,
  notify,
  openTask,
  onExit,
  desktop,
}: {
  client: AyanamiClient;
  project: RegisteredProject;
  notify: Notify;
  openTask: (key: string) => void;
  onExit: () => void;
  desktop?: DesktopBridge;
}) {
  const queryClient = useQueryClient();
  const [view, setView] = useState<"list" | "board" | "timeline" | "tree" | "records">("list");
  const [filters, setFilters] = useState<ProjectTaskFilters>(emptyTaskFilters);
  const [taskSort, setTaskSort] = useState<ProjectTaskSort | null>(null);
  const [create, setCreate] = useState(false);
  const [createRecord, setCreateRecord] = useState(false);
  const [dataTools, setDataTools] = useState(false);
  const [updateProject, setUpdateProject] = useState(false);
  const [reconciliationCollapsed, setReconciliationCollapsed] = useState(true);
  const tasks = useQuery({
    queryKey: ["tasks", project.code],
    queryFn: () => client.tasks.list(project.code, { limit: 100 }),
  });
  const brief = useQuery({
    queryKey: ["brief", project.code],
    queryFn: () => client.projects.brief(project.code),
  });
  const overview = useQuery({
    queryKey: ["overview"],
    queryFn: () => client.overview(),
  });
  const agents = useQuery({
    queryKey: ["agents", project.code],
    queryFn: () => client.projects.agents(project.code),
  });
  const updates = useQuery({
    queryKey: ["project-updates", project.code],
    queryFn: () => client.projects.updates(project.code),
  });
  const reconciliation = useQuery({
    queryKey: ["reconciliation", project.code],
    queryFn: () => client.projects.reconciliation(project.code),
  });
  const events = useQuery({
    queryKey: ["events", project.code],
    queryFn: () => client.events(project.code, 0, 100),
    enabled: view === "timeline",
  });
  const records = useQuery({
    queryKey: ["records", project.code],
    queryFn: () => client.projects.records(project.code),
    enabled: view === "records",
  });
  const lifecycle = useMutation({
    mutationFn: () =>
      project.lifecycle === "ARCHIVED"
        ? client.projects.restore(project.code)
        : client.projects.archive(project.code),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      await queryClient.invalidateQueries({ queryKey: ["overview"] });
      notify(project.lifecycle === "ARCHIVED" ? "项目已恢复" : "项目已归档");
    },
  });
  const trash = useMutation({
    mutationFn: () => client.projects.trash(project.code),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      notify("项目已移入垃圾箱，可在项目页恢复");
      onExit();
    },
  });
  useEffect(() => {
    const listener = () => setCreate(true);
    window.addEventListener("atm:new-project-task", listener);
    return () => window.removeEventListener("atm:new-project-task", listener);
  }, []);
  const workItems = (tasks.data ?? []) as any[];
  const projectSummary = ((overview.data?.projects ?? []) as any[]).find(
    (candidate) => candidate.code === project.code,
  );
  const inProgress = workItems.filter((task) =>
    ["CLAIMED", "IN_PROGRESS", "VERIFYING"].includes(task.status),
  );
  const ready = workItems.filter((task) => task.status === "READY");
  const blockers = workItems.filter((task) =>
    ["BLOCKED", "WAITING_USER", "WAITING_AGENT"].includes(task.status),
  );
  const onlineAgents = (agents.data ?? []).filter((agent) => agent.connection_state === "ONLINE");
  const claimedCount = workItems.filter((task) => Boolean(task.claimedBySessionId)).length;
  const latestUpdate = (updates.data ?? []).find((update) => update.status === "PUBLISHED");
  const filtered = (tasks.data ?? []).filter((task: any) => {
    if (filters.status && task.status !== filters.status) return false;
    if (filters.assignee && task.assigneeAgentId !== filters.assignee) return false;
    if (filters.milestone && task.milestoneId !== filters.milestone) return false;
    if (filters.blockedOnly && !task.blockedReason && task.status !== "BLOCKED") return false;
    if (filters.progressSource && task.progressSource !== filters.progressSource) return false;
    if (filters.due === "DATED" && !task.targetDate) return false;
    if (
      filters.due === "OVERDUE" &&
      (!task.targetDate ||
        task.targetDate >= new Date().toISOString().slice(0, 10) ||
        ["DONE", "CANCELLED"].includes(task.status))
    )
      return false;
    return true;
  });
  const sortedFiltered = sortProjectTasks(filtered, taskSort);
  const content = () => {
    if (tasks.isLoading) return <LoadingRows count={6} />;
    if (tasks.error) return <ErrorState error={tasks.error} />;
    if (view === "records") {
      if (records.isLoading) return <LoadingRows />;
      if (records.error) return <ErrorState error={records.error} />;
      return records.data?.length ? (
        <div className="atm-list">
          {records.data.map((record: any) => (
            <article className="atm-record" key={record.id}>
              <div className="atm-actions" style={{ justifyContent: "space-between" }}>
                <span className="atm-badge">
                  {(
                    {
                      DECISION: "决策",
                      CONSTRAINT: "约束",
                      FACT: "事实",
                      RISK: "风险",
                      REFERENCE: "参考",
                      LESSON: "经验",
                      VERIFICATION: "验证",
                      WAIVER: "豁免",
                    } as Record<string, string>
                  )[record.kind] ?? record.kind}
                </span>
                <span className="atm-row-sub">
                  {record.source_type === "USER"
                    ? "用户"
                    : record.source_type === "AGENT"
                      ? "Agent"
                      : record.source_type === "IMPORT"
                        ? "导入"
                        : "系统"}{" "}
                  · {formatTime(record.updated_at)}
                </span>
              </div>
              <h3>{record.title}</h3>
              {record.topic ? <div className="atm-key">主题：{record.topic}</div> : null}
              {record.subjectKey ? (
                <div className="atm-key">主题标识：{record.subjectKey}</div>
              ) : null}
              <p>{record.summary}</p>
              {(record.relatedRecords ?? record.related_records)?.length ? (
                <div className="atm-row-sub">
                  相关记录：{(record.relatedRecords ?? record.related_records).join("、")}
                </div>
              ) : null}
              {record.detail ? (
                <details>
                  <summary>查看详情</summary>
                  <div className="atm-description">{record.detail}</div>
                </details>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <Empty title="还没有项目记录" text="把决策、约束、风险和验证保存为持久上下文。" />
      );
    }
    if (view === "timeline") {
      if (events.isLoading) return <LoadingRows />;
      const rows = (events.data?.events ?? []) as any[];
      return rows.length ? (
        <div className="atm-timeline">
          {rows
            .slice()
            .reverse()
            .map((event) => {
              const item = presentTimelineEvent(event);
              return <TimelineEventRow event={event} key={item.id} />;
            })}
        </div>
      ) : (
        <Empty title="没有项目事件" text="任务发生变化后会显示在这里。" />
      );
    }
    if (!filtered.length) return <Empty title="没有匹配任务" text="调整筛选或创建任务。" />;
    if (view === "board") {
      const columns = [
        ["待开始", ["BACKLOG", "READY"]],
        ["进行中", ["CLAIMED", "IN_PROGRESS"]],
        ["受阻", ["BLOCKED", "WAITING_USER", "WAITING_AGENT"]],
        ["验收与完成", ["VERIFYING", "DONE"]],
      ] as const;
      return (
        <div className="atm-board">
          {columns.map(([label, states]) => (
            <section className="atm-column" key={label}>
              <div className="atm-column-head">
                <span>{label}</span>
                <span className="atm-key">
                  {filtered.filter((task: any) => states.includes(task.status as never)).length}
                </span>
              </div>
              {filtered
                .filter((task: any) => states.includes(task.status as never))
                .map((task: any) => (
                  <button
                    className="atm-task-card"
                    key={task.id}
                    onClick={() => openTask(task.key)}
                  >
                    <div className="atm-row-title">{task.title}</div>
                    <div className="atm-row-sub">
                      {task.key} · {Math.round(task.progress ?? 0)}%
                    </div>
                  </button>
                ))}
            </section>
          ))}
        </div>
      );
    }
    if (view === "tree") {
      const render = (parentId: string | null, depth: number): ReactNode =>
        filtered
          .filter((task: any) => (task.parentId ?? null) === parentId)
          .map((task: any) => (
            <div key={task.id}>
              <button
                className="atm-tree-row"
                style={{
                  width: "100%",
                  paddingLeft: 12 + depth * 22,
                  borderTop: 0,
                  borderRight: 0,
                  borderLeft: 0,
                  background: "transparent",
                  textAlign: "left",
                }}
                onClick={() => openTask(task.key)}
              >
                <GitBranch size={15} />
                <span className="atm-key">{task.key}</span>
                <span className="atm-row-title" style={{ flex: 1 }}>
                  {task.title}
                </span>
                {task.discoveredFrom ? (
                  <span className="atm-badge" title={`工作中发现于 ${task.discoveredFrom}`}>
                    发现于 {task.discoveredFrom}
                  </span>
                ) : null}
                {task.discoveredCount ? (
                  <span className="atm-badge" title={`工作中发现 ${task.discoveredCount} 项`}>
                    发现 {task.discoveredCount}
                  </span>
                ) : null}
                <Status value={task.status} />
              </button>
              {render(task.id, depth + 1)}
            </div>
          ));
      return <div className="atm-tree">{render(null, 0)}</div>;
    }
    return (
      <table className="atm-table">
        {/* 比例定死，窗口变窄时一起等比缩，而不是让任务列把别人挤没。
            数值按 1366 宽下的实测下限定：可排序表头自带图标，「更新时间」表头
            本身就要 76px、「优先级」要 65px，比单元格文本更吃宽度。 */}
        <colgroup>
          <col style={{ width: "27%" }} />
          <col style={{ width: "9%" }} />
          <col style={{ width: "9%" }} />
          <col style={{ width: "11%" }} />
          <col style={{ width: "7%" }} />
          <col style={{ width: "9%" }} />
          <col style={{ width: "12%" }} />
          <col style={{ width: "5%" }} />
          <col style={{ width: "11%" }} />
        </colgroup>
        <thead>
          <tr>
            <th>任务</th>
            <ProjectTaskSortHeader
              field="status"
              label="状态"
              sort={taskSort}
              onSort={(field) => setTaskSort((current) => toggleProjectTaskSort(current, field))}
            />
            <ProjectTaskSortHeader
              field="priority"
              label="优先级"
              sort={taskSort}
              onSort={(field) => setTaskSort((current) => toggleProjectTaskSort(current, field))}
            />
            <th>负责人</th>
            <th>层级</th>
            <th>计划日</th>
            <th>阻塞 / 等待</th>
            <th>进度</th>
            <ProjectTaskSortHeader
              field="updatedAt"
              label="更新时间"
              sort={taskSort}
              onSort={(field) => setTaskSort((current) => toggleProjectTaskSort(current, field))}
            />
          </tr>
        </thead>
        <tbody>
          {sortedFiltered.map((task: any) => (
            <tr key={task.id} onClick={() => openTask(task.key)}>
              <td>
                <div className="atm-row-title">{task.title}</div>
                <span className="atm-key">{task.key}</span>
              </td>
              <td>
                <Status value={task.status} />
              </td>
              <td>{priorityLabels[task.priority] ?? task.priority}</td>
              <td>
                {task.assigneeAgentId === "USER" ? "桌面用户" : (task.assigneeAgentId ?? "未分配")}
              </td>
              <td className="atm-key">{task.parentId ? "子任务" : "根任务"}</td>
              <td>{task.targetDate ?? "—"}</td>
              <td>
                <span className="atm-cell-wrap">
                  {task.blockedReason || task.waitingFor || "—"}
                </span>
              </td>
              <td className="atm-key">{Math.round(task.progress ?? 0)}%</td>
              <td>{formatTime(task.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  };
  return (
    <>
      <PageHead
        title={project.name}
        description={project.description || `${project.code} 的正式项目工作区。`}
        actions={
          <>
            <button className="atm-button" onClick={() => setUpdateProject(true)}>
              发布项目更新
            </button>
            <button className="atm-button" onClick={() => setDataTools(true)}>
              数据工具
            </button>
            <button
              className="atm-button"
              onClick={async () => {
                const configs = await desktop?.getMcpConfigs?.();
                if (configs && desktop?.copyText) {
                  await desktop.copyText(`${configs.agentRule}\n项目代码：${project.code}`);
                  notify("Agent 开工规则与项目代码已复制");
                } else notify("请让 Agent 调用 atm_begin，并传入当前项目代码");
              }}
            >
              <Play size={16} />
              启动 Agent 会话
            </button>
            <button
              className={`atm-button ${project.lifecycle === "ARCHIVED" ? "" : "danger"}`}
              onClick={() => lifecycle.mutate()}
              disabled={lifecycle.isPending}
            >
              {project.lifecycle === "ARCHIVED" ? (
                <ArrowCounterClockwise size={16} />
              ) : (
                <Archive size={16} />
              )}
              {project.lifecycle === "ARCHIVED" ? "恢复项目" : "归档项目"}
            </button>
            {project.lifecycle === "ARCHIVED" ? (
              <button
                className="atm-button danger"
                disabled={trash.isPending}
                onClick={() => {
                  if (window.confirm("移入垃圾箱前会创建备份，之后可从项目页恢复。继续吗？"))
                    trash.mutate();
                }}
              >
                移入垃圾箱
              </button>
            ) : null}
            {view === "records" ? (
              <button
                className="atm-button primary"
                onClick={() => setCreateRecord(true)}
                disabled={project.lifecycle !== "ACTIVE"}
              >
                <Plus size={16} />
                新建记录
              </button>
            ) : (
              <button
                className="atm-button primary"
                onClick={() => setCreate(true)}
                disabled={project.lifecycle !== "ACTIVE"}
              >
                <Plus size={16} />
                新建任务
              </button>
            )}
          </>
        }
      />
      <section className="atm-metrics five">
        <div className="atm-metric">
          <div className="label">当前目标</div>
          <div style={{ marginTop: 12, fontWeight: 650 }}>
            {String(brief.data?.objective ?? "尚未设置")}
          </div>
        </div>
        <div className="atm-metric">
          <div className="label">当前里程碑</div>
          <div style={{ marginTop: 12, fontWeight: 650 }}>
            {String(brief.data?.milestone ?? "尚未设置")}
          </div>
        </div>
        <div className="atm-metric">
          <div className="label">健康度</div>
          <div style={{ marginTop: 12 }}>
            <Status value={String(projectSummary?.health ?? "UNKNOWN")} />
          </div>
          <div className="detail">最近活动 {formatTime(projectSummary?.last_activity_at)}</div>
        </div>
        <div className="atm-metric">
          <div className="label">项目进度</div>
          <div className="value">{Math.round(Number(projectSummary?.progress ?? 0))}%</div>
          <div className="detail">
            {progressSourceLabels[String(projectSummary?.progress_source ?? "NONE")] ?? "尚无进度"}
          </div>
        </div>
        <div className="atm-metric">
          <div className="label">下一目标日期</div>
          <div style={{ marginTop: 12, fontWeight: 650 }}>
            {String(projectSummary?.next_target_date ?? "尚未设置")}
          </div>
          <div className="detail">
            项目更新 {formatTime(projectSummary?.last_project_update_at)}
          </div>
        </div>
      </section>
      <section className="atm-management-grid" aria-label="项目管理摘要">
        <article className="atm-panel atm-management-card">
          <div className="atm-panel-head">
            <h2>当前进行</h2>
            <span className="atm-badge primary">{inProgress.length}</span>
          </div>
          {inProgress.length ? (
            <div className="atm-list">
              {inProgress.slice(0, 4).map((task) => (
                <button className="atm-row" key={task.id} onClick={() => openTask(task.key)}>
                  <div>
                    <div className="atm-row-title">{task.title}</div>
                    <div className="atm-row-sub">
                      {task.key} · {Math.round(task.progress ?? 0)}%
                    </div>
                  </div>
                  <Status value={task.status} />
                </button>
              ))}
            </div>
          ) : (
            <Empty title="没有进行中任务" text="从可开始任务中选择下一项。" />
          )}
        </article>
        <article className="atm-panel atm-management-card">
          <div className="atm-panel-head">
            <h2>阻塞与等待</h2>
            <span className={`atm-badge ${blockers.length ? "danger" : "success"}`}>
              {blockers.length}
            </span>
          </div>
          {blockers.length ? (
            <div className="atm-list">
              {blockers.slice(0, 4).map((task) => (
                <button className="atm-row" key={task.id} onClick={() => openTask(task.key)}>
                  <div>
                    <div className="atm-row-title">{task.title}</div>
                    <div className="atm-row-sub">
                      {task.blockedReason || task.waitingFor || "等待条件未说明"}
                    </div>
                  </div>
                  <Status value={task.status} />
                </button>
              ))}
            </div>
          ) : (
            <Empty title="没有阻塞" text="当前没有需要外部处理的条件。" />
          )}
        </article>
        <article className="atm-panel atm-management-card">
          <div className="atm-panel-head">
            <h2>Agent 与领取</h2>
            <span className="atm-badge">在线 {onlineAgents.length}</span>
          </div>
          <div className="atm-panel-body">
            <div className="atm-row-title">{claimedCount} 项任务已领取</div>
            <div className="atm-row-sub">
              {onlineAgents.length
                ? onlineAgents.map((agent) => agent.display_name || agent.agent_id).join("、")
                : "尚无在线 Agent 会话"}
            </div>
            {onlineAgents.map((agent: any) => (
              <div
                className="atm-row-sub"
                key={agent.id}
                title={agent.worktree_root || agent.cwd || ""}
              >
                {agent.display_name || agent.agent_id} · {agent.current_task_key || "未领取"} ·{" "}
                {agent.git_branch || "非 Git"} · {compactPath(agent.worktree_root)}
              </div>
            ))}
          </div>
          <div className="atm-panel-head">
            <h2>最近项目更新</h2>
          </div>
          <div className="atm-panel-body">
            <div className="atm-row-title">{latestUpdate?.summary ?? "尚未发布项目更新"}</div>
            <div className="atm-row-sub">
              {latestUpdate
                ? `${statusLabels[latestUpdate.health] ?? latestUpdate.health} · ${formatTime(latestUpdate.publishedAt)}`
                : "发布后会形成可追溯的项目判断"}
            </div>
          </div>
        </article>
        <article className="atm-panel atm-management-card">
          <div className="atm-panel-head">
            <h2>下一步</h2>
            <span className="atm-badge">可开始 {ready.length}</span>
          </div>
          {ready.length ? (
            <div className="atm-list">
              {ready.slice(0, 5).map((task) => (
                <button className="atm-row" key={task.id} onClick={() => openTask(task.key)}>
                  <div>
                    <div className="atm-row-title">{task.title}</div>
                    <div className="atm-row-sub">
                      {task.key} · {priorityLabels[task.priority] ?? task.priority}
                    </div>
                  </div>
                  <ArrowRight size={16} />
                </button>
              ))}
            </div>
          ) : (
            <Empty title="没有 READY 任务" text="拆解并创建下一项可执行工作。" />
          )}
        </article>
      </section>
      <section
        className={`atm-panel atm-engineering${reconciliationCollapsed ? " is-collapsed" : ""}`}
        aria-label="任务对账"
      >
        <div className="atm-panel-head">
          <button
            type="button"
            className="atm-engineering-toggle"
            aria-label={reconciliationCollapsed ? "展开任务对账" : "折叠任务对账"}
            aria-expanded={!reconciliationCollapsed}
            aria-controls="task-reconciliation-content"
            onClick={() => setReconciliationCollapsed((collapsed) => !collapsed)}
          >
            <CaretDown size={17} aria-hidden="true" />
            <span>
              <strong>
                {reconciliation.error ? "对账检查失败" : reconciliationSummary(reconciliation.data)}
              </strong>
            </span>
          </button>
        </div>
        <div id="task-reconciliation-content" hidden={reconciliationCollapsed}>
          {reconciliation.isLoading ? (
            <LoadingRows count={2} />
          ) : reconciliation.error ? (
            <ErrorState error={reconciliation.error} />
          ) : reconciliation.data?.items.length ? (
            <div className="atm-list">
              {reconciliation.data.items.map((item) => (
                <button
                  className="atm-row"
                  key={`${item.taskKey}:${item.classification}`}
                  onClick={() => openTask(item.taskKey)}
                >
                  <div>
                    <div className="atm-row-title">{item.title}</div>
                    <div className="atm-row-sub">
                      {item.taskKey} · {reconciliationLabel(item.classification)} · 已持续{" "}
                      {formatReconciliationAge(item.ageSeconds)}
                    </div>
                    {item.session ? (
                      <div className="atm-row-sub">
                        Session：{item.session.displayName} · {item.session.connectionState}
                      </div>
                    ) : null}
                    {item.evidencePaths.length ? (
                      <div className="atm-row-sub">已发现产物：{item.evidencePaths.join("、")}</div>
                    ) : null}
                    <div className="atm-row-sub">建议：{item.suggestedAction}</div>
                  </div>
                  <span
                    className={`atm-badge ${
                      item.classification === "STALLED"
                        ? "danger"
                        : item.classification === "LEASE_EXPIRED_ONLINE"
                          ? "warning"
                          : "primary"
                    }`}
                  >
                    {reconciliationLabel(item.classification)}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="atm-panel-body">
              <div className="atm-row-title">当前没有需对账项</div>
            </div>
          )}
        </div>
      </section>
      <EngineeringMetricsPanel
        client={client}
        projectCode={project.code}
        formatCapturedAt={formatTime}
      />
      <div className="atm-toolbar">
        <div className="atm-tabs" role="tablist">
          <button aria-selected={view === "list"} onClick={() => setView("list")}>
            <ListBullets size={15} /> 列表
          </button>
          <button aria-selected={view === "board"} onClick={() => setView("board")}>
            <Kanban size={15} /> 看板
          </button>
          <button aria-selected={view === "timeline"} onClick={() => setView("timeline")}>
            <ClockCounterClockwise size={15} /> 时间线
          </button>
          <button aria-selected={view === "tree"} onClick={() => setView("tree")}>
            <Rows size={15} /> 层级
          </button>
          <button aria-selected={view === "records"} onClick={() => setView("records")}>
            <CheckSquare size={15} /> 记录
          </button>
        </div>
      </div>
      {!new Set(["timeline", "records"]).has(view) ? (
        <ProjectTaskFilterBar
          client={client}
          project={project.code}
          tasks={tasks.data ?? []}
          value={filters}
          onChange={setFilters}
          notify={notify}
        />
      ) : null}
      <section className="atm-panel">{content()}</section>
      {create ? (
        <CreateTaskModal
          client={client}
          project={project.code}
          close={() => setCreate(false)}
          notify={notify}
        />
      ) : null}
      {createRecord ? (
        <CreateRecordModal
          client={client}
          project={project.code}
          close={() => setCreateRecord(false)}
          notify={notify}
        />
      ) : null}
      {updateProject ? (
        <ProjectUpdateModal
          client={client}
          project={project.code}
          close={() => setUpdateProject(false)}
          notify={notify}
        />
      ) : null}
      {dataTools ? (
        <ProjectDataModal
          client={client}
          project={project.code}
          close={() => setDataTools(false)}
          notify={notify}
        />
      ) : null}
    </>
  );
}

function CommandPalette({
  client,
  close,
  onProject,
  onTask,
}: {
  client: AyanamiClient;
  close: () => void;
  onProject: (code: string) => void;
  onTask: (project: string, key: string) => void;
}) {
  const dialogRef = useDialogAccessibility(close);
  const [query, setQuery] = useState("");
  const result = useQuery({
    queryKey: ["search", query],
    queryFn: () => client.search(query),
    enabled: query.trim().length > 0,
  });
  const hits = ((result.data as any)?.hits ?? []) as any[];
  return (
    <div
      className="atm-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        ref={dialogRef}
        className="atm-modal atm-command"
        role="dialog"
        aria-modal="true"
        aria-label="全局搜索"
        tabIndex={-1}
      >
        <input
          data-dialog-autofocus
          aria-label="全局搜索"
          placeholder="搜索任务、记录、阻塞和临时任务"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query && result.isLoading ? (
          <LoadingRows count={3} />
        ) : query && result.error ? (
          <ErrorState error={result.error} />
        ) : query && hits.length === 0 ? (
          <Empty title="没有搜索结果" text="换一个更短或更具体的关键词。" />
        ) : (
          <div className="atm-command-results">
            {hits.map((hit, index) => (
              <button
                className="atm-row"
                key={`${hit.entity_key}:${index}`}
                onClick={() => {
                  if (hit.entity_type === "WORK_ITEM" && hit.project)
                    onTask(hit.project, hit.entity_key);
                  else if (hit.project) onProject(hit.project);
                  close();
                }}
              >
                <div>
                  <div className="atm-row-title">{hit.title}</div>
                  <div className="atm-row-sub">
                    {hit.entity_key} · {hit.project ?? "临时任务"}
                  </div>
                </div>
                <ArrowRight size={16} />
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function App({
  client,
  desktop,
  brandLogoSrc,
}: {
  client: AyanamiClient;
  desktop?: DesktopBridge;
  brandLogoSrc?: string;
}) {
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => client.projects.list() });
  const [route, setRoute] = useState<Route>(() => (location.hash.slice(1) as Route) || "overview");
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme() ?? readSystemTheme());
  const [hasManualTheme, setHasManualTheme] = useState(() => readStoredTheme() !== null);
  const [palette, setPalette] = useState(false);
  const [notice, setNotice] = useState("");
  const [drawer, setDrawer] = useState<{ project: string; key: string } | null>(null);
  const notify = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 2800);
  };
  useEffect(() => {
    location.hash = route;
  }, [route]);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.themeSwitching = "true";
    root.dataset.theme = theme;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => delete root.dataset.themeSwitching);
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
      delete root.dataset.themeSwitching;
    };
  }, [theme]);
  useEffect(() => {
    if (hasManualTheme) return;
    const preference = window.matchMedia("(prefers-color-scheme: dark)");
    const syncSystemTheme = (event: MediaQueryListEvent) =>
      setTheme(event.matches ? "dark" : "light");
    preference.addEventListener("change", syncSystemTheme);
    return () => preference.removeEventListener("change", syncSystemTheme);
  }, [hasManualTheme]);
  useEffect(() => desktop?.onNavigate?.((next) => setRoute(next as Route)), [desktop]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        !(event.ctrlKey || event.metaKey) ||
        isEditableTarget(event.target) ||
        document.querySelector('[role="dialog"]')
      )
        return;
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette(true);
      }
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        if (route.startsWith("project:")) window.dispatchEvent(new Event("atm:new-project-task"));
        else setRoute("quick");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [route]);
  const projectList = projects.data ?? [];
  const selectedProject = route.startsWith("project:")
    ? projectList.find((project) => project.code === route.slice(8))
    : null;
  const openTask = (project: string, key: string) => {
    setRoute(`project:${project}`);
    setDrawer({ project, key });
  };
  const title =
    selectedProject?.name ??
    (
      {
        overview: "总览",
        projects: "项目",
        my: "活动任务",
        quick: "临时任务",
        blockers: "阻塞与等待",
        agents: "Agent",
        timeline: "全局时间线",
        settings: "设置",
      } as Record<string, string>
    )[route] ??
    "工作区";
  let page: ReactNode;
  if (route === "overview")
    page = (
      <OverviewPage
        client={client}
        onProject={(code) => setRoute(`project:${code}`)}
        onQuick={() => setRoute("quick")}
        notify={notify}
      />
    );
  else if (route === "projects")
    page = (
      <ProjectsPage
        client={client}
        onProject={(code) => setRoute(`project:${code}`)}
        notify={notify}
        {...(desktop ? { desktop } : {})}
      />
    );
  else if (route === "my")
    page = (
      <>
        <PageHead title="活动任务" description="所有正式项目中已领取、进行中和验收中的任务。" />
        <TasksAcrossProjects
          client={client}
          projects={projectList}
          mode="active"
          onTask={openTask}
        />
      </>
    );
  else if (route === "quick") page = <QuickPage client={client} notify={notify} />;
  else if (route === "blockers")
    page = (
      <>
        <PageHead
          title="阻塞与等待"
          description="集中处理被阻塞、等待用户或等待其他 Agent 的工作。"
        />
        <TasksAcrossProjects
          client={client}
          projects={projectList}
          mode="blocked"
          onTask={openTask}
        />
      </>
    );
  else if (route === "agents") page = <AgentsPage client={client} projects={projectList} />;
  else if (route === "timeline") page = <TimelinePage client={client} />;
  else if (route === "settings")
    page = <SettingsPage client={client} {...(desktop === undefined ? {} : { desktop })} />;
  else if (selectedProject)
    page = (
      <ProjectPage
        client={client}
        project={selectedProject}
        notify={notify}
        openTask={(key) => setDrawer({ project: selectedProject.code, key })}
        onExit={() => setRoute("projects")}
        {...(desktop ? { desktop } : {})}
      />
    );
  else page = <ErrorState error="找不到这个项目，可能已被移除或路径发生变化。" />;
  return (
    <div className="atm-shell">
      <Sidebar
        route={route}
        setRoute={setRoute}
        projects={projectList}
        {...(brandLogoSrc ? { brandLogoSrc } : {})}
      />
      <main className="atm-main">
        <header className="atm-topbar">
          <div className="atm-breadcrumb">{title}</div>
          <button className="atm-search-button" onClick={() => setPalette(true)}>
            <MagnifyingGlass size={17} />
            搜索任务、记录和项目<kbd>Ctrl K</kbd>
          </button>
          <div className="atm-top-actions" data-testid="window-drag-actions">
            <button
              className="atm-button atm-icon-button atm-theme-toggle"
              aria-label={theme === "light" ? "切换至暗黑模式" : "切换至亮色模式"}
              title={theme === "light" ? "切换至暗黑模式" : "切换至亮色模式"}
              onClick={() => {
                const nextTheme = theme === "light" ? "dark" : "light";
                setHasManualTheme(true);
                setTheme(nextTheme);
                persistTheme(nextTheme);
              }}
            >
              {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}
            </button>
            <button
              className="atm-button"
              onClick={() => {
                if (route.startsWith("project:"))
                  window.dispatchEvent(new Event("atm:new-project-task"));
                else setRoute("quick");
              }}
            >
              <Plus size={16} />
              {route.startsWith("project:") ? "新建任务" : "临时任务"}
              <kbd>Ctrl N</kbd>
            </button>
            <Status value={projects.error ? "MIGRATION_FAILED" : "ACTIVE"} />
          </div>
        </header>
        <div className="atm-content">{page}</div>
      </main>
      {palette ? (
        <CommandPalette
          client={client}
          close={() => setPalette(false)}
          onProject={(code) => setRoute(`project:${code}`)}
          onTask={openTask}
        />
      ) : null}
      {drawer ? (
        <TaskDrawer
          client={client}
          project={drawer.project}
          taskKey={drawer.key}
          close={() => setDrawer(null)}
          notify={notify}
        />
      ) : null}
      {notice ? (
        <div className="atm-notice" role="status">
          {notice}
        </div>
      ) : null}
    </div>
  );
}

export function AyanamiTaskManager({
  client,
  desktop,
  brandLogoSrc,
}: {
  client: AyanamiClient;
  desktop?: DesktopBridge;
  brandLogoSrc?: string;
}) {
  const [queryClient] = useState(() => createAyanamiQueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <App
        client={client}
        {...(desktop === undefined ? {} : { desktop })}
        {...(brandLogoSrc ? { brandLogoSrc } : {})}
      />
    </QueryClientProvider>
  );
}

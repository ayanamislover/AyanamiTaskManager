import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ArchiveIcon as Archive } from "@phosphor-icons/react/dist/icons/Archive";
import { ArrowCounterClockwiseIcon as ArrowCounterClockwise } from "@phosphor-icons/react/dist/icons/ArrowCounterClockwise";
import { ArrowRightIcon as ArrowRight } from "@phosphor-icons/react/dist/icons/ArrowRight";
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
import { AyanamiClient, type RegisteredProject } from "@ayanami-task/client";
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
type DesktopBridge = {
  runtime?: { endpoint: string; token: string };
  setAutoLaunch?: (enabled: boolean) => Promise<boolean>;
  getAutoLaunch?: () => Promise<boolean>;
  showItemInFolder?: (path: string) => Promise<void>;
  getMcpConfigs?: () => Promise<{
    streamableHttp: string;
    stdio: string;
    generic: string;
    agentRule: string;
  }>;
  installMcp?: (client: "CODEX" | "CLAUDE") => Promise<{ path: string; backupPath: string | null }>;
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
const eventLabels: Record<string, string> = {
  "quick.created": "创建临时任务",
  "quick.updated": "更新临时任务",
  "quick.promoted": "临时任务已晋升",
  "project.creating": "开始创建项目",
  "project.created": "项目已创建",
  "project.archived": "项目已归档",
  "project.restored": "项目已恢复",
  "project.summary.updated": "项目摘要已更新",
  "project.trashed": "项目已移入垃圾箱",
  "objective.created": "目标已创建",
  "milestone.created": "里程碑已创建",
  "work.created": "任务已创建",
  "work.started": "任务已开始",
  "work.claimed": "任务已领取",
  "work.blocked": "任务进入阻塞",
  "work.waiting": "任务进入等待",
  "work.completed": "任务已完成",
  "work.cancelled": "任务已取消",
  "work.reopened": "任务已重新打开",
  "work.verification_requested": "任务已提交验收",
  "checklist.updated": "检查项已更新",
  "record.created": "项目记录已创建",
  "agent.joined": "Agent 已加入",
  "agent.left": "Agent 已离开",
  "project.update.drafted": "项目更新草稿已生成",
  "project.update.published": "项目更新已发布",
  "backup.created": "备份已创建",
  "backup.restored": "备份已恢复",
  "import.agenttask.applied": "旧任务账本已导入",
};

function eventLabel(code: string): string {
  return eventLabels[code] ?? "项目发生变化";
}

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
  const global = [
    ["overview", "总览", House],
    ["projects", "项目", FolderOpen],
    ["my", "活动任务", CheckSquare],
    ["quick", "临时任务", Lightning],
    ["blockers", "阻塞与等待", WarningCircle],
    ["agents", "Agent", UsersThree],
    ["timeline", "全局时间线", ClockCounterClockwise],
    ["settings", "设置", GearSix],
  ] as const;
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
        <div className="atm-nav-group">
          <div className="atm-nav-title">工作区</div>
          <nav className="atm-nav">
            {global.map(([key, label, Icon]) => (
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
                    aria-current={route === `project:${project.code}` ? "page" : undefined}
                    onClick={() => setRoute(`project:${project.code}`)}
                  >
                    <span className="atm-key" style={{ minWidth: 30 }}>
                      {project.code}
                    </span>
                    <span>{project.name}</span>
                  </button>
                ))}
            </nav>
          </div>
        ) : null}
        <div className="atm-sidebar-footer">本地优先 · 每项目独立数据库</div>
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
    refetchInterval: 15_000,
  });
  const quickQuery = useQuery({
    queryKey: ["quick"],
    queryFn: () => client.quick.list(),
    refetchInterval: 15_000,
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
              {(data.recentEvents as any[]).slice(0, 8).map((event) => (
                <div className="atm-event" key={event.sequence}>
                  <div className="atm-row-title">{eventLabel(String(event.type))}</div>
                  <div className="atm-row-sub">
                    {event.actor} · {formatTime(event.created_at)}
                  </div>
                </div>
              ))}
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
    mutationFn: (target: "CODEX" | "CLAUDE") => desktop!.installMcp!(target),
    onSuccess: (result) => notify(`Agent 配置已安装：${result.path}`),
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
                <select
                  id="project-mode"
                  value={form.mode}
                  onChange={(e) => field("mode", e.target.value)}
                >
                  <option value="SOLO">单 Agent</option>
                  <option value="AUTO">自动判断</option>
                  <option value="MULTI">多 Agent</option>
                </select>
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
                      安装到 Claude
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
          <select
            className="atm-filter"
            aria-label="晋升目标项目"
            value={targetProject}
            onChange={(event) => setTargetProject(event.target.value)}
          >
            <option value="">选择晋升目标</option>
            {projects.data
              ?.filter((project) => project.lifecycle === "ACTIVE")
              .map((project) => (
                <option key={project.id} value={project.code}>
                  {project.code} · {project.name}
                </option>
              ))}
          </select>
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
  if (queries.some((query) => query.isLoading))
    return (
      <>
        <PageHead title="Agent" description="项目内已注册的 Agent 会话和最近活动。" />
        <LoadingRows />
      </>
    );
  const sessions = queries.flatMap((query) => query.data ?? []);
  return (
    <>
      <PageHead
        title="Agent"
        description="在线状态来自项目数据库中的正式会话；可显式关闭异常会话并释放其领取。"
      />
      <section className="atm-panel">
        {sessions.length === 0 ? (
          <Empty title="没有 Agent 会话" text="Agent 调用 atm_begin 后会在这里出现。" />
        ) : (
          <table className="atm-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>项目</th>
                <th>角色</th>
                <th>状态</th>
                <th>最后活动</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session: any) => (
                <tr key={`${session.project}:${session.id}`}>
                  <td>
                    <div className="atm-row-title">{session.display_name}</div>
                    <span className="atm-key">{session.agent_id}</span>
                  </td>
                  <td>{session.project}</td>
                  <td>{statusLabels[session.role] ?? session.role}</td>
                  <td>
                    <Status value={session.connection_state} />
                  </td>
                  <td>{formatTime(session.last_seen_at)}</td>
                  <td>
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
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
            {(query.data!.recentEvents as any[]).map((event) => (
              <div className="atm-event" key={event.sequence}>
                <div className="atm-row-title">{eventLabel(String(event.type))}</div>
                <div className="atm-row-sub">
                  序列 {event.sequence} · {event.actor} · {formatTime(event.created_at)}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
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
  const [autoLaunch, setAutoLaunch] = useState<boolean | null>(null);
  const [dailyEnabled, setDailyEnabled] = useState(true);
  const [dailyKeep, setDailyKeep] = useState(7);
  const [weeklyKeep, setWeeklyKeep] = useState(4);
  const [notifications, setNotifications] = useState(true);
  const [feedback, setFeedback] = useState("");
  useEffect(() => {
    void desktop?.getAutoLaunch?.().then(setAutoLaunch);
  }, [desktop]);
  useEffect(() => {
    if (!settings.data) return;
    const backup = settings.data.find((entry) => entry.key === "backup.policy")?.value as any;
    const notification = settings.data.find((entry) => entry.key === "notification.enabled")?.value;
    if (backup) {
      setDailyEnabled(backup.enabled !== false);
      setDailyKeep(Number(backup.dailyKeep ?? 7));
      setWeeklyKeep(Number(backup.weeklyKeep ?? 4));
    }
    if (typeof notification === "boolean") setNotifications(notification);
  }, [settings.data]);
  const savePolicy = useMutation({
    mutationFn: async () => {
      const backup = settings.data?.find((entry) => entry.key === "backup.policy");
      const notification = settings.data?.find((entry) => entry.key === "notification.enabled");
      await client.settings.put(
        "backup.policy",
        { enabled: dailyEnabled, dailyKeep, weeklyKeep },
        Number(backup?.version ?? -1),
      );
      await client.settings.put(
        "notification.enabled",
        notifications,
        Number(notification?.version ?? -1),
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
      setFeedback("设置已保存");
    },
  });
  const install = useMutation({
    mutationFn: (target: "CODEX" | "CLAUDE") => desktop!.installMcp!(target),
    onSuccess: (result) => setFeedback(`已安装并保留原配置：${result.path}`),
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
                      安装时先备份现有配置，只合并 AyanamiTaskManager，不覆盖其他 MCP Server。
                    </div>
                    <div className="atm-actions">
                      <button
                        className="atm-button primary"
                        disabled={install.isPending}
                        onClick={() => install.mutate("CODEX")}
                      >
                        安装到 Codex
                      </button>
                      <button
                        className="atm-button"
                        disabled={install.isPending}
                        onClick={() => install.mutate("CLAUDE")}
                      >
                        安装到 Claude
                      </button>
                    </div>
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
            {install.error ? (
              <div className="atm-inline-error">
                {install.error instanceof Error ? install.error.message : String(install.error)}
              </div>
            ) : null}
          </div>
        </section>
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
            <label className="atm-check">
              <input
                type="checkbox"
                checked={notifications}
                onChange={(event) => setNotifications(event.target.checked)}
              />
              <span>允许系统通知（等待、严重阻塞、完成和维护失败）</span>
            </label>
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
        queryClient.invalidateQueries({ queryKey: ["brief", project] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
      ]);
      notify("任务状态已更新");
    },
  });
  const check = useMutation({
    mutationFn: async (item: any) =>
      client.tasks.checklistAsUser(project, item.id, {
        opId: `ui-check-${crypto.randomUUID()}`,
        checklistId: item.id,
        expectedVersion: item.version,
        status: item.status === "DONE" ? "TODO" : "DONE",
        evidence: item.evidence ?? [],
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["task", project, taskKey] }),
        queryClient.invalidateQueries({ queryKey: ["tasks", project] }),
        queryClient.invalidateQueries({ queryKey: ["brief", project] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
      ]);
    },
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
          <button className="atm-button atm-icon-button" onClick={close} aria-label="关闭">
            <X size={17} />
          </button>
        </header>
        {query.isLoading ? (
          <LoadingRows />
        ) : query.error ? (
          <ErrorState error={query.error} />
        ) : (
          <div className="atm-drawer-body">
            <div className="atm-actions">
              <Status value={String(query.data!.status)} />
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
                <span style={{ width: `${Number(query.data!.progress ?? 0)}%` }} />
              </div>
              <div className="atm-row-sub">
                {Math.round(Number(query.data!.progress ?? 0))}% ·{" "}
                {progressSourceLabels[String(query.data!.progressSource)] ?? "状态计算"}
              </div>
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
                (query.data!.checklist as any[]).map((item) => (
                  <label className="atm-check" key={item.id}>
                    <input
                      type="checkbox"
                      checked={item.status === "DONE"}
                      disabled={check.isPending}
                      onChange={() => check.mutate(item)}
                    />
                    <span>
                      {item.title}
                      {item.evidenceRequired ? (
                        <span className="atm-row-sub"> · 需要证据</span>
                      ) : null}
                    </span>
                  </label>
                ))
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
              <select
                id="task-priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              >
                <option value="LOW">低</option>
                <option value="NORMAL">普通</option>
                <option value="HIGH">高</option>
                <option value="CRITICAL">紧急</option>
              </select>
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
  const [kind, setKind] = useState("DECISION");
  const [importance, setImportance] = useState("NORMAL");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [detail, setDetail] = useState("");
  const mutation = useMutation({
    mutationFn: () =>
      client.recordAsUser(project, {
        opId: `ui-record-${crypto.randomUUID()}`,
        kind,
        importance,
        title,
        summary,
        detail,
        scope: "PROJECT",
      }),
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
              <select
                id="record-kind"
                value={kind}
                onChange={(event) => setKind(event.target.value)}
              >
                <option value="DECISION">决策</option>
                <option value="CONSTRAINT">约束</option>
                <option value="FACT">事实</option>
                <option value="RISK">风险</option>
                <option value="REFERENCE">参考</option>
                <option value="LESSON">经验</option>
                <option value="VERIFICATION">验证</option>
                <option value="WAIVER">豁免</option>
              </select>
            </div>
            <div className="atm-field">
              <label htmlFor="record-importance">重要性</label>
              <select
                id="record-importance"
                value={importance}
                onChange={(event) => setImportance(event.target.value)}
              >
                <option value="LOW">低</option>
                <option value="NORMAL">普通</option>
                <option value="HIGH">高</option>
                <option value="CRITICAL">紧急</option>
              </select>
            </div>
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
                <select
                  id="project-health"
                  value={health}
                  onChange={(event) => setHealth(event.target.value)}
                >
                  <option value="UNKNOWN">未知</option>
                  <option value="ON_TRACK">正常</option>
                  <option value="AT_RISK">有风险</option>
                  <option value="OFF_TRACK">偏离计划</option>
                </select>
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
      <select
        className="atm-filter"
        aria-label="保存视图"
        value={selected}
        onChange={(event) => {
          const id = event.target.value;
          setSelected(id);
          const view = views.data?.find((candidate) => candidate.id === id);
          if (view)
            onChange({ ...emptyTaskFilters, ...(view.query as Partial<ProjectTaskFilters>) });
        }}
      >
        <option value="">保存视图</option>
        {views.data?.map((view) => (
          <option key={view.id} value={view.id}>
            {view.name}
          </option>
        ))}
      </select>
      <select
        className="atm-filter"
        aria-label="状态筛选"
        value={value.status}
        onChange={(event) => patch({ status: event.target.value })}
      >
        <option value="">全部状态</option>
        {Object.entries(statusLabels)
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
          .map(([key, label]) => (
            <option value={key} key={key}>
              {label}
            </option>
          ))}
      </select>
      <select
        className="atm-filter"
        aria-label="Agent 筛选"
        value={value.assignee}
        onChange={(event) => patch({ assignee: event.target.value })}
      >
        <option value="">全部负责人</option>
        {assignees.map((agent) => (
          <option value={agent} key={agent}>
            {agent === "USER" ? "桌面用户" : agent}
          </option>
        ))}
      </select>
      <select
        className="atm-filter"
        aria-label="里程碑筛选"
        value={value.milestone}
        onChange={(event) => patch({ milestone: event.target.value })}
      >
        <option value="">全部里程碑</option>
        {milestones.data?.map((milestone) => (
          <option value={milestone.id} key={milestone.id}>
            {milestone.title}
          </option>
        ))}
      </select>
      <select
        className="atm-filter"
        aria-label="截止日期筛选"
        value={value.due}
        onChange={(event) => patch({ due: event.target.value as ProjectTaskFilters["due"] })}
      >
        <option value="">全部日期</option>
        <option value="OVERDUE">已超期</option>
        <option value="DATED">已设目标日</option>
      </select>
      <select
        className="atm-filter"
        aria-label="进度来源筛选"
        value={value.progressSource}
        onChange={(event) => patch({ progressSource: event.target.value })}
      >
        <option value="">全部进度来源</option>
        {Object.entries(progressSourceLabels).map(([key, label]) => (
          <option value={key} key={key}>
            {label}
          </option>
        ))}
      </select>
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
  const [create, setCreate] = useState(false);
  const [createRecord, setCreateRecord] = useState(false);
  const [dataTools, setDataTools] = useState(false);
  const [updateProject, setUpdateProject] = useState(false);
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
  const engineering = useQuery({
    queryKey: ["engineering-metrics", project.code],
    queryFn: () => client.projects.engineeringMetrics(project.code),
  });
  const refreshEngineering = useMutation({
    mutationFn: () => client.projects.engineeringMetrics(project.code, undefined, true),
    onSuccess: (value) => queryClient.setQueryData(["engineering-metrics", project.code], value),
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
              <p>{record.summary}</p>
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
            .map((event) => (
              <div className="atm-event" key={event.seq}>
                <div className="atm-row-title">
                  {event.summary || eventLabel(String(event.type))}
                </div>
                <div className="atm-row-sub">
                  {eventLabel(String(event.type))} · 序列 {event.seq} · {formatTime(event.at)}
                </div>
              </div>
            ))}
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
                <Status value={task.status} />
              </button>
              {render(task.id, depth + 1)}
            </div>
          ));
      return <div className="atm-tree">{render(null, 0)}</div>;
    }
    return (
      <table className="atm-table">
        <thead>
          <tr>
            <th>任务</th>
            <th>状态</th>
            <th>优先级</th>
            <th>负责人</th>
            <th>层级</th>
            <th>计划日</th>
            <th>阻塞 / 等待</th>
            <th>进度</th>
            <th>更新</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((task: any) => (
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
              <td>{task.blockedReason || task.waitingFor || "—"}</td>
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
      <section className="atm-panel atm-engineering" aria-label="工程统计">
        <div className="atm-panel-head">
          <div>
            <h2>工程统计</h2>
            <div className="atm-row-sub">由本地 Git 与文件事实计算，不生成质量评分</div>
          </div>
          <button
            className="atm-button"
            disabled={refreshEngineering.isPending}
            onClick={() => refreshEngineering.mutate()}
          >
            {refreshEngineering.isPending ? "正在统计" : "刷新统计"}
          </button>
        </div>
        {engineering.isLoading ? (
          <LoadingRows count={2} />
        ) : engineering.data?.available ? (
          <div className="atm-engineering-body">
            <div className="atm-engineering-kpis">
              <div>
                <span>Source LOC</span>
                <strong>{Number(engineering.data.project.sourceLoc).toLocaleString()}</strong>
              </div>
              <div>
                <span>Test LOC</span>
                <strong>{Number(engineering.data.project.testLoc).toLocaleString()}</strong>
              </div>
              <div>
                <span>文件</span>
                <strong>{Number(engineering.data.project.fileCount).toLocaleString()}</strong>
              </div>
              <div>
                <span>依赖</span>
                <strong>{Number(engineering.data.project.dependencyCount).toLocaleString()}</strong>
              </div>
              <div>
                <span>7 日净 LOC</span>
                <strong>{Number(engineering.data.project.netLoc7d).toLocaleString()}</strong>
              </div>
              <div>
                <span>30 日净 LOC</span>
                <strong>{Number(engineering.data.project.netLoc30d).toLocaleString()}</strong>
              </div>
            </div>
            {Math.abs(Number(engineering.data.project.netLoc7d)) > 5_000 ? (
              <div className="atm-inline-warning">
                最近 7 日实现规模偏大，请确认工作项是否需要继续拆分。
              </div>
            ) : null}
            <div className="atm-form-grid">
              <div>
                <h3>最大文件</h3>
                {(engineering.data.project.largestFiles as any[]).slice(0, 6).map((item) => (
                  <div className="atm-metric-file" key={item.path}>
                    <span>{item.path}</span>
                    <strong>{item.loc} LOC</strong>
                  </div>
                ))}
              </div>
              <div>
                <h3>高 churn（30 日）</h3>
                {(engineering.data.project.highChurnFiles as any[]).slice(0, 6).map((item) => (
                  <div className="atm-metric-file" key={item.path}>
                    <span>{item.path}</span>
                    <strong>{item.churn}</strong>
                  </div>
                ))}
              </div>
            </div>
            <div className="atm-row-sub">
              HEAD {String(engineering.data.project.head).slice(0, 10)} ·{" "}
              {formatTime(engineering.data.project.capturedAt)}
            </div>
          </div>
        ) : (
          <div className="atm-panel-body">
            <div className="atm-row-title">此项目暂不可统计</div>
            <div className="atm-row-sub">
              {engineering.data?.reason === "NO_SOURCE_PATH"
                ? "项目没有源码目录"
                : (engineering.data?.message ?? "源码目录不是可读取的 Git 仓库")}
            </div>
          </div>
        )}
      </section>
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
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, staleTime: 3000, refetchOnWindowFocus: true },
          mutations: { retry: false },
        },
      }),
  );
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

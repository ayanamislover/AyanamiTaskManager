import { Fragment, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArchiveIcon as Archive } from "@phosphor-icons/react/dist/icons/Archive";
import { ArrowCounterClockwiseIcon as ArrowCounterClockwise } from "@phosphor-icons/react/dist/icons/ArrowCounterClockwise";
import { ArrowRightIcon as ArrowRight } from "@phosphor-icons/react/dist/icons/ArrowRight";
import { CaretDownIcon as CaretDown } from "@phosphor-icons/react/dist/icons/CaretDown";
import { CaretRightIcon as CaretRight } from "@phosphor-icons/react/dist/icons/CaretRight";
import { CheckCircleIcon as CheckCircle } from "@phosphor-icons/react/dist/icons/CheckCircle";
import { CheckSquareIcon as CheckSquare } from "@phosphor-icons/react/dist/icons/CheckSquare";
import { ClockCounterClockwiseIcon as ClockCounterClockwise } from "@phosphor-icons/react/dist/icons/ClockCounterClockwise";
import { FolderOpenIcon as FolderOpen } from "@phosphor-icons/react/dist/icons/FolderOpen";
import { GitBranchIcon as GitBranch } from "@phosphor-icons/react/dist/icons/GitBranch";
import { KanbanIcon as Kanban } from "@phosphor-icons/react/dist/icons/Kanban";
import { ListBulletsIcon as ListBullets } from "@phosphor-icons/react/dist/icons/ListBullets";
import { PlayIcon as Play } from "@phosphor-icons/react/dist/icons/Play";
import { PlusIcon as Plus } from "@phosphor-icons/react/dist/icons/Plus";
import { RowsIcon as Rows } from "@phosphor-icons/react/dist/icons/Rows";
import { XIcon as X } from "@phosphor-icons/react/dist/icons/X";
import {
  AyanamiClient,
  type RegisteredProject,
  type UserRecordCreateInput,
} from "@ayanami-task/client";
import { type WorkItemStatus } from "@ayanami-task/protocol";
import {
  findAgentSessionConflicts,
  groupAgentSessions,
  type AgentSessionLike,
} from "./agent-sessions.js";
import { checklistToggleIntent, evidenceText } from "./checklist-evidence.js";
import { EngineeringMetricsPanel } from "./project-statistics-panel.js";
import { ProjectProjectionPanel, SystemProjectionPanel } from "./projection-health-panel.js";
import { McpBridgePanel } from "./mcp-bridge-panel.js";
import { createAyanamiQueryClient } from "./query-policy.js";
import { recordDraftToUserInput } from "./record-input.js";
import { useCursorCollection, useCursorCollections } from "./cursor-collection.js";
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
import { workItemUiActions } from "./task-actions.js";
import { AtmSelect } from "./components/atm-select.js";
import {
  CursorLoadStatus,
  Empty,
  ErrorState,
  LoadingRows,
  PageHead,
} from "./components/async-state.js";
import { useDialogAccessibility } from "./hooks/use-dialog-accessibility.js";
import { useAppShortcuts } from "./hooks/use-app-shortcuts.js";
import { useNotice } from "./hooks/use-notice.js";
import { useTheme } from "./hooks/use-theme.js";
import { AppShell } from "./shell/app-shell.js";
import { OverviewPage, TasksAcrossProjects } from "./features/overview.js";
import {
  appRouteTitle,
  useAppRouteState,
  useDesktopRouteNavigation,
  useRouteHash,
} from "./routes/use-app-route.js";
import type {
  AgentIntegrationAction,
  AyanamiTaskManagerProps,
  DesktopBridge,
  McpClient,
  NotificationMode,
  Notify,
} from "./contracts.js";
import {
  AgentIntegrationBadge,
  Status,
  agentClientLabel,
  compactPath,
  formatDuration,
  formatTime,
  integrationState,
  priorityLabels,
  progressSourceLabels,
  statusLabels,
} from "./presentation.js";
import "./styles.css";

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
  const agentSources = projects
    .filter((project) => project.lifecycle === "ACTIVE")
    .map((project) => ({
      key: project.code,
      loadPage: (cursor?: string) => client.projects.agentPage(project.code, 100, cursor),
    }));
  const collection = useCursorCollections(
    ["agents", "all", ...agentSources.map((source) => source.key)],
    agentSources,
  );
  const entries = Object.values(collection.entries);
  const loadedSessionCount = entries.reduce((total, entry) => total + entry.loadedCount, 0);
  const isLoading = entries.some((entry) => entry.isLoading);
  const errorEntry = entries.find((entry) => entry.error);
  const error = errorEntry?.error;
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
  if (isLoading && loadedSessionCount === 0)
    return (
      <>
        <PageHead title="Agent" description="项目内已注册的 Agent 会话和最近活动。" />
        <LoadingRows />
      </>
    );
  if (error && loadedSessionCount === 0)
    return (
      <>
        <PageHead title="Agent" description="项目内已注册的 Agent 会话和最近活动。" />
        <CursorLoadStatus
          loadedCount={loadedSessionCount}
          hasMore={false}
          error={error}
          onRetry={() => (errorEntry ? void collection.retry(errorEntry.key) : undefined)}
        />
        <ErrorState error={error} />
      </>
    );
  const allSessions = entries.flatMap((entry) =>
    entry.items.map((session) => ({ ...session, project: entry.key })),
  ) as AgentSessionLike[];
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
      <CursorLoadStatus
        loadedCount={loadedSessionCount}
        hasMore={entries.some((entry) => entry.hasMore)}
        loading={isLoading || entries.some((entry) => entry.isFetchingNextPage)}
        error={error}
        onRetry={() => {
          for (const entry of entries) {
            if (entry.error) void collection.retry(entry.key);
          }
        }}
      />
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
                      data-agent-id={session.agentId}
                      key={`${session.project}:${session.agentId}`}
                    >
                      <header className="agent-session-card-header">
                        <div className="agent-session-identity">
                          <div className="atm-row-title">
                            {session.displayName || session.agentId || "未命名 Agent"}
                          </div>
                          <div className="atm-row-sub">
                            <span className="atm-key">{session.agentId}</span> ·{" "}
                            {session.sessionCount} 个 Session
                          </div>
                        </div>
                        <div className="agent-session-status">
                          <Status value={String(session.connectionState || "UNKNOWN")} />
                          <span className="atm-row-sub">{session.workState || "空闲"}</span>
                        </div>
                      </header>

                      <div className="agent-session-primary-grid">
                        <div className="agent-session-field">
                          <span>当前任务</span>
                          <strong>{session.currentTaskKey || "未领取"}</strong>
                        </div>
                        <div className="agent-session-field">
                          <span>角色</span>
                          <strong>{statusLabels[session.role] ?? session.role ?? "未知"}</strong>
                        </div>
                        <div className="agent-session-field">
                          <span>Git branch</span>
                          <strong title={session.git?.branch || ""}>
                            {session.git?.branch || "非 Git"}
                          </strong>
                        </div>
                        <div className="agent-session-field">
                          <span>Worktree</span>
                          <strong title={session.git?.worktreeRoot || ""}>
                            {compactPath(session.git?.worktreeRoot)}
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
                            <strong>{String(session.git?.head || "不可用").slice(0, 10)}</strong>
                          </div>
                          <div>
                            <span>Git 状态</span>
                            <strong>
                              {session.git?.available
                                ? session.git.dirty
                                  ? "dirty"
                                  : "clean"
                                : session.git?.error || "未观察"}
                            </strong>
                          </div>
                          <div>
                            <span>最后活动</span>
                            <strong>{formatTime(session.lastSeenAt)}</strong>
                          </div>
                          <div>
                            <span>持续时间</span>
                            <strong>{formatDuration(session.startedAt)}</strong>
                          </div>
                        </div>
                        {session.sessionHistory.length > 1 ? (
                          <div className="agent-session-history" aria-label="历史 Session">
                            <div className="agent-session-history-title">历史 Session</div>
                            {session.sessionHistory.map((history: any) => (
                              <div className="agent-session-history-row" key={history.id}>
                                <span className="atm-key">{history.id}</span>
                                <Status value={String(history.connectionState || "UNKNOWN")} />
                                <span>{formatTime(history.lastSeenAt)}</span>
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
                          最近活动：{formatTime(session.lastSeenAt)}
                        </span>
                        <span className="atm-actions">
                          <button
                            className="atm-button"
                            disabled={refreshGit.isPending}
                            onClick={() => refreshGit.mutate(session)}
                          >
                            刷新 Git
                          </button>
                          {session.connectionState === "ONLINE" ? (
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
        {query.data ? (
          <SystemProjectionPanel
            client={client}
            summary={query.data.projectionSummary}
            failures={query.data.projectionFailures}
            notify={setFeedback}
          />
        ) : null}
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
                          <div className="atm-row-title">完整工具面（memory + actions）</div>
                          <div className="atm-row-sub">
                            默认开启完整工具面。关闭会同时移除 memory 与 actions 两个静态
                            Profile，只保留 core，但关闭后将失去
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
    queryKey: ["task", project, taskKey, "full"],
    queryFn: async () => {
      const [view, metadata] = await Promise.all([
        client.tasks.get(project, taskKey, "full"),
        client.tasks.getForUi(project, taskKey),
      ]);
      return { ...metadata, ...view };
    },
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
              {workItemUiActions({
                status: String(query.data!.status) as WorkItemStatus,
                actor: "USER",
                claimOwner:
                  typeof (query.data as Record<string, unknown>).assigneeAgentId === "string"
                    ? String((query.data as Record<string, unknown>).assigneeAgentId)
                    : null,
                claimStale: Boolean(
                  (query.data as Record<string, unknown>).claimLeaseUntil &&
                    Date.parse(String((query.data as Record<string, unknown>).claimLeaseUntil)) <=
                      Date.now(),
                ),
              }).map(({ operation, label }) => (
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
              <h3>任务关系</h3>
              <div className="atm-actions">
                {query.data!.relations.length ? (
                  query.data!.relations.map((relation) => {
                    const label =
                      relation.type === "PARENT"
                        ? "父任务"
                        : relation.type === "CHILD"
                          ? "子任务"
                          : relation.type === "BLOCKS"
                            ? relation.direction === "INCOMING"
                              ? "依赖"
                              : "阻塞"
                            : relation.type === "DISCOVERED_FROM"
                              ? relation.direction === "OUTGOING"
                                ? "发现于"
                                : "发现"
                              : relation.type === "DUPLICATES"
                                ? "重复"
                                : "相关";
                    return (
                      <span
                        className={`atm-badge ${relation.type === "DISCOVERED_FROM" ? "primary" : ""}`}
                        key={`${relation.type}-${relation.direction}-${relation.taskKey}`}
                      >
                        {label} {relation.taskKey}
                      </span>
                    );
                  })
                ) : (
                  <span className="atm-row-sub">没有任务关系</span>
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
  const tasks = useCursorCollection(["tasks", project.code, "ui"], (cursor) =>
    client.tasks.pageForUi(project.code, {
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    }),
  );
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
  const records = useCursorCollection(
    ["records", project.code],
    (cursor) => client.projects.recordPage(project.code, 100, cursor),
    view === "records",
  );
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
  const workItems = tasks.items as any[];
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
  const onlineAgents = (agents.data ?? []).filter((agent) => agent.connectionState === "ONLINE");
  const claimedCount = workItems.filter((task) => Boolean(task.claimedBySessionId)).length;
  const latestUpdate = (updates.data ?? []).find((update) => update.status === "PUBLISHED");
  const filtered = tasks.items.filter((task: any) => {
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
    if (tasks.isLoading && tasks.items.length === 0) return <LoadingRows count={6} />;
    if (tasks.error && tasks.items.length === 0)
      return (
        <>
          <ErrorState error={tasks.error} />
          <button className="atm-button" onClick={() => void tasks.retry()}>
            重试加载
          </button>
        </>
      );
    if (view === "records") {
      if (records.isLoading && records.items.length === 0) return <LoadingRows />;
      if (records.error && records.items.length === 0)
        return (
          <>
            <CursorLoadStatus
              loadedCount={records.items.length}
              hasMore={false}
              error={records.error}
              onRetry={() => void records.retry()}
            />
            <ErrorState error={records.error} />
          </>
        );
      return records.items.length ? (
        <>
          <CursorLoadStatus
            loadedCount={records.items.length}
            hasMore={records.hasMore}
            loading={records.isFetchingNextPage}
            error={records.error}
            onRetry={() => void records.retry()}
          />
          <div className="atm-list">
            {records.items.map((record: any) => (
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
                    {record.sourceType === "USER"
                      ? "用户"
                      : record.sourceType === "AGENT"
                        ? "Agent"
                        : record.sourceType === "IMPORT"
                          ? "导入"
                          : "系统"}{" "}
                    · {formatTime(record.updatedAt)}
                  </span>
                </div>
                <h3>{record.title}</h3>
                {record.topic ? <div className="atm-key">主题：{record.topic}</div> : null}
                {record.subjectKey ? (
                  <div className="atm-key">主题标识：{record.subjectKey}</div>
                ) : null}
                <p>{record.summary}</p>
                {record.relatedRecords.length ? (
                  <div className="atm-row-sub">相关记录：{record.relatedRecords.join("、")}</div>
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
        </>
      ) : (
        <>
          <CursorLoadStatus loadedCount={0} hasMore={false} />
          <Empty title="还没有项目记录" text="把决策、约束、风险和验证保存为持久上下文。" />
        </>
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
                ? onlineAgents.map((agent) => agent.displayName || agent.agentId).join("、")
                : "尚无在线 Agent 会话"}
            </div>
            {onlineAgents.map((agent: any) => (
              <div
                className="atm-row-sub"
                key={agent.id}
                title={agent.git?.worktreeRoot || agent.cwd || ""}
              >
                {agent.displayName || agent.agentId} · {agent.currentTaskKey || "未领取"} ·{" "}
                {agent.git?.branch || "非 Git"} · {compactPath(agent.git?.worktreeRoot)}
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
      <ProjectProjectionPanel
        client={client}
        projectCode={project.code}
        state={projectSummary?.projection ?? null}
        notify={notify}
      />
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
          tasks={tasks.items}
          value={filters}
          onChange={setFilters}
          notify={notify}
        />
      ) : null}
      {tasks.items.length || tasks.error ? (
        <CursorLoadStatus
          loadedCount={tasks.loadedCount}
          hasMore={tasks.hasMore}
          loading={tasks.isFetchingNextPage}
          error={tasks.error}
          onRetry={() => void tasks.retry()}
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
  const [route, setRoute] = useAppRouteState();
  const [palette, setPalette] = useState(false);
  const [drawer, setDrawer] = useState<{ project: string; key: string } | null>(null);
  const { notice, notify } = useNotice();
  useRouteHash(route);
  const { theme, toggleTheme } = useTheme();
  useDesktopRouteNavigation(desktop, setRoute);
  useAppShortcuts(route, setRoute, setPalette);
  const projectList = projects.data ?? [];
  const selectedProject = route.startsWith("project:")
    ? projectList.find((project) => project.code === route.slice(8))
    : null;
  const openTask = (project: string, key: string) => {
    setRoute(`project:${project}`);
    setDrawer({ project, key });
  };
  const title = appRouteTitle(route, selectedProject?.name);
  let page: ReactNode;
  if (route === "overview")
    page = (
      <OverviewPage
        client={client}
        onProject={(code) => setRoute(`project:${code}`)}
        onQuick={() => setRoute("quick")}
        notify={notify}
        TimelineEventRow={TimelineEventRow}
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
    <AppShell
      route={route}
      onRoute={setRoute}
      projects={projectList}
      {...(brandLogoSrc ? { brandLogoSrc } : {})}
      title={title}
      theme={theme}
      statusSlot={<Status value={projects.error ? "MIGRATION_FAILED" : "ACTIVE"} />}
      content={page}
      paletteSlot={
        palette ? (
          <CommandPalette
            client={client}
            close={() => setPalette(false)}
            onProject={(code) => setRoute(`project:${code}`)}
            onTask={openTask}
          />
        ) : null
      }
      drawerSlot={
        drawer ? (
          <TaskDrawer
            client={client}
            project={drawer.project}
            taskKey={drawer.key}
            close={() => setDrawer(null)}
            notify={notify}
          />
        ) : null
      }
      noticeSlot={notice}
      onSearch={() => setPalette(true)}
      onToggleTheme={toggleTheme}
      onCreate={() => {
        if (route.startsWith("project:")) window.dispatchEvent(new Event("atm:new-project-task"));
        else setRoute("quick");
      }}
    />
  );
}

export function AyanamiTaskManager({ client, desktop, brandLogoSrc }: AyanamiTaskManagerProps) {
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

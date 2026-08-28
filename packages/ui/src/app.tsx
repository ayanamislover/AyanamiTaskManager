import { useEffect, useState, type ReactNode } from "react";
import { QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArchiveIcon as Archive } from "@phosphor-icons/react/dist/icons/Archive";
import { ArrowCounterClockwiseIcon as ArrowCounterClockwise } from "@phosphor-icons/react/dist/icons/ArrowCounterClockwise";
import { ArrowRightIcon as ArrowRight } from "@phosphor-icons/react/dist/icons/ArrowRight";
import { PlayIcon as Play } from "@phosphor-icons/react/dist/icons/Play";
import { PlusIcon as Plus } from "@phosphor-icons/react/dist/icons/Plus";
import { AyanamiClient, type RegisteredProject } from "@ayanami-task/client";
import { createAyanamiQueryClient } from "./query-policy.js";
import { useCursorCollection } from "./cursor-collection.js";
import { Empty, ErrorState, LoadingRows, PageHead } from "./components/async-state.js";
import { useDialogAccessibility } from "./hooks/use-dialog-accessibility.js";
import { useAppShortcuts } from "./hooks/use-app-shortcuts.js";
import { useNotice } from "./hooks/use-notice.js";
import { useTheme } from "./hooks/use-theme.js";
import { AppShell } from "./shell/app-shell.js";
import { AgentsPage } from "./features/agents.js";
import { CreateRecordModal } from "./features/create-record-modal.js";
import { CreateTaskModal } from "./features/create-task-modal.js";
import { OverviewPage, TasksAcrossProjects } from "./features/overview.js";
import { ProjectDataModal } from "./features/project-data-modal.js";
import { ProjectSummary } from "./features/project-summary.js";
import { ProjectTaskControls, useProjectTaskViewState } from "./features/project-task-controls.js";
import { ProjectTaskViews } from "./features/project-task-views.js";
import { ProjectUpdateModal } from "./features/project-update-modal.js";
import { ProjectsPage } from "./features/projects.js";
import { QuickPage } from "./features/quick.js";
import { SettingsPage } from "./features/settings.js";
import { TaskDrawer } from "./features/task-drawer.js";
import { GlobalTimelinePage, TimelineEventRow } from "./features/timeline.js";
import {
  appRouteTitle,
  useAppRouteState,
  useDesktopRouteNavigation,
  useRouteHash,
} from "./routes/use-app-route.js";
import type { AyanamiTaskManagerProps, DesktopBridge, Notify } from "./contracts.js";
import { Status } from "./presentation.js";
import "./styles.css";

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
  const [create, setCreate] = useState(false);
  const [createRecord, setCreateRecord] = useState(false);
  const [dataTools, setDataTools] = useState(false);
  const [updateProject, setUpdateProject] = useState(false);
  const tasks = useCursorCollection(["tasks", project.code, "ui"], (cursor) =>
    client.tasks.pageForUi(project.code, {
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    }),
  );
  const { view, setView, filters, setFilters, taskSort, filteredTasks, sortedTasks, onTaskSort } =
    useProjectTaskViewState(tasks.items);
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
      <ProjectSummary
        client={client}
        projectCode={project.code}
        workItems={workItems}
        notify={notify}
        openTask={openTask}
      />
      <ProjectTaskControls
        client={client}
        project={project.code}
        tasks={tasks.items}
        view={view}
        onViewChange={setView}
        filters={filters}
        onFiltersChange={setFilters}
        notify={notify}
      />
      <ProjectTaskViews
        view={view}
        tasks={tasks}
        records={records}
        events={events}
        filteredTasks={filteredTasks}
        sortedTasks={sortedTasks}
        taskSort={taskSort}
        onTaskSort={onTaskSort}
        onOpenTask={openTask}
      />
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
  else if (route === "timeline") page = <GlobalTimelinePage client={client} />;
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

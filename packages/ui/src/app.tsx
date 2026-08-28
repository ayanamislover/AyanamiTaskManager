import { useState, type ReactNode } from "react";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { ArrowRightIcon as ArrowRight } from "@phosphor-icons/react/dist/icons/ArrowRight";
import { AyanamiClient } from "@ayanami-task/client";
import { createAyanamiQueryClient } from "./query-policy.js";
import { Empty, ErrorState, LoadingRows, PageHead } from "./components/async-state.js";
import { useDialogAccessibility } from "./hooks/use-dialog-accessibility.js";
import { useAppShortcuts } from "./hooks/use-app-shortcuts.js";
import { useNotice } from "./hooks/use-notice.js";
import { useTheme } from "./hooks/use-theme.js";
import { AppShell } from "./shell/app-shell.js";
import { AgentsPage } from "./features/agents.js";
import { OverviewPage, TasksAcrossProjects } from "./features/overview.js";
import { ProjectPage } from "./features/project.js";
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
import type { AyanamiTaskManagerProps, DesktopBridge } from "./contracts.js";
import { Status } from "./presentation.js";
import "./styles.css";

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
  const openTaskInPlace = (project: string, key: string) => setDrawer({ project, key });
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
          onTask={openTaskInPlace}
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
          onTask={openTaskInPlace}
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

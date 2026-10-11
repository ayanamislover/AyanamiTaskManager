import { useEffect, useState } from "react";
import { QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AyanamiClient } from "@ayanami-task/client";
import { createAyanamiQueryClient } from "./query-policy.js";
import { DialogProvider } from "./components/atm-dialogs.js";
import { Presence } from "./components/presence.js";
import { useAppShortcuts } from "./hooks/use-app-shortcuts.js";
import { useNotice } from "./hooks/use-notice.js";
import { useTheme } from "./hooks/use-theme.js";
import { AppShell } from "./shell/app-shell.js";
import { useProjectOrder } from "./project-order.js";
import { ServiceStatus } from "./shell/service-status.js";
import { CommandPalette } from "./features/command-palette.js";
import { DataSourceChoicePage } from "./features/data-source-choice.js";
import { TaskDrawer } from "./features/task-drawer.js";
import { AppRouter } from "./routes/app-router.js";
import type { KnowledgeDraftSeed } from "./features/knowledge.js";
import {
  appRouteTitle,
  useAppRouteState,
  useDesktopRouteNavigation,
  useRouteHash,
} from "./routes/use-app-route.js";
import type {
  AyanamiTaskManagerProps,
  DataSourceChoice,
  DataSourceState,
  DesktopBridge,
} from "./contracts.js";
import "./styles.css";
import { requestNewProjectTask } from "./hooks/new-project-task.js";

/**
 * 宿主里服务的状态（07 §7）：数据源冲突、或正在按用户的选择启动时，内容区换成选源页。
 * 回到「在服务」时让所有读重新来一遍：冲突期间失败的读不能留在界面上。浏览器预览没有桌面桥，永远是 null。
 */
function useDataSource(desktop: DesktopBridge | undefined) {
  const queryClient = useQueryClient();
  const [source, setSource] = useState<DataSourceState | null>(null);
  useEffect(() => {
    if (!desktop?.getDataSource) return;
    let alive = true;
    const unsubscribe = desktop.onDataSourceChange?.((next) => alive && setSource(next));
    void desktop.getDataSource().then(
      (next) => alive && setSource(next),
      () => undefined,
    );
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, [desktop]);
  const blocking =
    source?.state === "SOURCE_CONFLICT" || (source?.state === "STARTING" && source.choosing);
  const [wasBlocking, setWasBlocking] = useState(false);
  useEffect(() => {
    if (blocking) setWasBlocking(true);
    else if (wasBlocking && source?.state === "SERVING") {
      setWasBlocking(false);
      void queryClient.invalidateQueries();
    }
  }, [blocking, wasBlocking, source, queryClient]);
  const choose = async (choice: DataSourceChoice) => {
    const next = await desktop!.chooseDataSource!(choice);
    setSource(next);
  };
  return { source: blocking ? source : null, choose };
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
  const dataSource = useDataSource(desktop);
  const [route, setRoute] = useAppRouteState();
  const [palette, setPalette] = useState(false);
  const [drawer, setDrawer] = useState<{ project: string; key: string } | null>(null);
  const [knowledgeDraft, setKnowledgeDraft] = useState<KnowledgeDraftSeed | null>(null);
  const { notice, notify } = useNotice();
  useRouteHash(route);
  const { theme, toggleTheme } = useTheme();
  useDesktopRouteNavigation(desktop, setRoute);
  useAppShortcuts(route, setRoute, setPalette);
  // 手动顺序在这里统一应用一次，侧栏和项目页拿到的是同一份排序结果。
  // 总览的项目卡片来自 client.overview 自己的数组，在 OverviewPage 里套同一个 hook（ATM-T-0421）。
  const projectOrder = useProjectOrder(client);
  const projectList = projectOrder.apply(projects.data ?? []);
  const selectedProject = route.startsWith("project:")
    ? projectList.find((project) => project.code === route.slice(8))
    : null;
  const openTask = (project: string, key: string) => {
    setRoute(`project:${project}`);
    setDrawer({ project, key });
  };
  const openTaskInPlace = (project: string, key: string) => setDrawer({ project, key });
  const title = appRouteTitle(route, selectedProject?.name);
  return (
    <AppShell
      route={route}
      onRoute={setRoute}
      projects={projectList}
      projectOrder={projectOrder}
      {...(brandLogoSrc ? { brandLogoSrc } : {})}
      title={title}
      theme={theme}
      statusSlot={<ServiceStatus error={projects.error} loading={projects.isPending} />}
      content={
        dataSource.source ? (
          <DataSourceChoicePage source={dataSource.source} choose={dataSource.choose} />
        ) : (
          <AppRouter
            client={client}
            desktop={desktop}
            route={route}
            projects={projectList}
            projectsPending={projects.data === undefined}
            projectsError={
              projects.data === undefined && !projects.isFetching ? projects.error : null
            }
            onRetryProjects={() => void projects.refetch()}
            notify={notify}
            onRoute={setRoute}
            onTask={openTaskInPlace}
            knowledgeDraft={knowledgeDraft}
            onKnowledgeDraft={setKnowledgeDraft}
            onKnowledgeDraftConsumed={() => setKnowledgeDraft(null)}
          />
        )
      }
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
        <Presence present={Boolean(drawer)} inertWhenClosing>
          {drawer ? (
            <TaskDrawer
              client={client}
              project={drawer.project}
              taskKey={drawer.key}
              close={() => setDrawer(null)}
              notify={notify}
            />
          ) : null}
        </Presence>
      }
      noticeSlot={notice}
      onSearch={() => setPalette(true)}
      onToggleTheme={toggleTheme}
      onCreate={() => {
        if (route.startsWith("project:")) requestNewProjectTask(route.slice(8));
        else setRoute("quick");
      }}
    />
  );
}

export function AyanamiTaskManager({ client, desktop, brandLogoSrc }: AyanamiTaskManagerProps) {
  const [queryClient] = useState(() => createAyanamiQueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <DialogProvider>
        <App
          client={client}
          {...(desktop === undefined ? {} : { desktop })}
          {...(brandLogoSrc ? { brandLogoSrc } : {})}
        />
      </DialogProvider>
    </QueryClientProvider>
  );
}

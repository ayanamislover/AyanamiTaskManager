import { useState } from "react";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
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
import { TaskDrawer } from "./features/task-drawer.js";
import { AppRouter } from "./routes/app-router.js";
import type { KnowledgeDraftSeed } from "./features/knowledge.js";
import {
  appRouteTitle,
  useAppRouteState,
  useDesktopRouteNavigation,
  useRouteHash,
} from "./routes/use-app-route.js";
import type { AyanamiTaskManagerProps, DesktopBridge } from "./contracts.js";
import "./styles.css";

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
  const [knowledgeDraft, setKnowledgeDraft] = useState<KnowledgeDraftSeed | null>(null);
  const { notice, notify } = useNotice();
  useRouteHash(route);
  const { theme, toggleTheme } = useTheme();
  useDesktopRouteNavigation(desktop, setRoute);
  useAppShortcuts(route, setRoute, setPalette);
  // 手动顺序在这里统一应用一次，侧栏和项目页拿到的是同一份排序结果。
  // 总览不在其中：它的项目卡片来自 client.overview 自己的数组，没过这一层（ATM-T-0421）。
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
        <AppRouter
          client={client}
          desktop={desktop}
          route={route}
          projects={projectList}
          selectedProject={selectedProject ?? null}
          notify={notify}
          onRoute={setRoute}
          onTask={openTaskInPlace}
          knowledgeDraft={knowledgeDraft}
          onKnowledgeDraft={setKnowledgeDraft}
          onKnowledgeDraftConsumed={() => setKnowledgeDraft(null)}
        />
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

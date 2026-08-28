import { useState } from "react";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { AyanamiClient } from "@ayanami-task/client";
import { createAyanamiQueryClient } from "./query-policy.js";
import { Presence } from "./components/presence.js";
import { useAppShortcuts } from "./hooks/use-app-shortcuts.js";
import { useNotice } from "./hooks/use-notice.js";
import { useTheme } from "./hooks/use-theme.js";
import { AppShell } from "./shell/app-shell.js";
import { CommandPalette } from "./features/command-palette.js";
import { TaskDrawer } from "./features/task-drawer.js";
import { AppRouter } from "./routes/app-router.js";
import {
  appRouteTitle,
  useAppRouteState,
  useDesktopRouteNavigation,
  useRouteHash,
} from "./routes/use-app-route.js";
import type { AyanamiTaskManagerProps, DesktopBridge } from "./contracts.js";
import { Status } from "./presentation.js";
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
  return (
    <AppShell
      route={route}
      onRoute={setRoute}
      projects={projectList}
      {...(brandLogoSrc ? { brandLogoSrc } : {})}
      title={title}
      theme={theme}
      statusSlot={<Status value={projects.error ? "MIGRATION_FAILED" : "ACTIVE"} />}
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
      <App
        client={client}
        {...(desktop === undefined ? {} : { desktop })}
        {...(brandLogoSrc ? { brandLogoSrc } : {})}
      />
    </QueryClientProvider>
  );
}

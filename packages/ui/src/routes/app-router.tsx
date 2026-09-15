import type { ReactNode } from "react";
import type { AyanamiClient, RegisteredProject } from "@ayanami-task/client";
import { ErrorState, PageHead } from "../components/async-state.js";
import type { DesktopBridge, Notify, Route } from "../contracts.js";
import { AgentsPage } from "../features/agents.js";
import { OverviewPage, TasksAcrossProjects } from "../features/overview.js";
import { ProjectPage } from "../features/project.js";
import { ProjectsPage } from "../features/projects.js";
import { QuickPage } from "../features/quick.js";
import { SettingsPage } from "../features/settings.js";
import { GlobalTimelinePage, TimelineEventRow } from "../features/timeline.js";
import { KnowledgePage, type KnowledgeDraftSeed } from "../features/knowledge.js";

export function AppRouter({
  client,
  desktop,
  route,
  projects,
  selectedProject,
  notify,
  onRoute,
  onTask,
  knowledgeDraft,
  onKnowledgeDraft,
  onKnowledgeDraftConsumed,
}: {
  client: AyanamiClient;
  desktop: DesktopBridge | undefined;
  route: Route;
  projects: RegisteredProject[];
  selectedProject: RegisteredProject | null;
  notify: Notify;
  onRoute: (route: Route) => void;
  onTask: (project: string, key: string) => void;
  knowledgeDraft: KnowledgeDraftSeed | null;
  onKnowledgeDraft: (draft: KnowledgeDraftSeed) => void;
  onKnowledgeDraftConsumed: () => void;
}): ReactNode {
  if (route === "overview")
    return (
      <OverviewPage
        client={client}
        onProject={(code) => onRoute(`project:${code}`)}
        onQuick={() => onRoute("quick")}
        notify={notify}
        TimelineEventRow={TimelineEventRow}
      />
    );
  if (route === "projects")
    return (
      <ProjectsPage
        client={client}
        onProject={(code) => onRoute(`project:${code}`)}
        notify={notify}
        {...(desktop ? { desktop } : {})}
      />
    );
  if (route === "my")
    return (
      <>
        <PageHead title="活动任务" description="所有正式项目中已领取、进行中和验收中的任务。" />
        <TasksAcrossProjects client={client} projects={projects} mode="active" onTask={onTask} />
      </>
    );
  if (route === "quick") return <QuickPage client={client} notify={notify} />;
  if (route === "blockers")
    return (
      <>
        <PageHead
          title="阻塞与等待"
          description="集中处理被阻塞、等待用户或等待其他 Agent 的工作。"
        />
        <TasksAcrossProjects client={client} projects={projects} mode="blocked" onTask={onTask} />
      </>
    );
  if (route === "agents") return <AgentsPage client={client} projects={projects} />;
  if (route === "timeline") return <GlobalTimelinePage client={client} />;
  if (route === "knowledge")
    return (
      <KnowledgePage
        client={client}
        notify={notify}
        draft={knowledgeDraft}
        onDraftConsumed={onKnowledgeDraftConsumed}
      />
    );
  if (route === "settings")
    return <SettingsPage client={client} {...(desktop === undefined ? {} : { desktop })} />;
  if (selectedProject)
    return (
      <ProjectPage
        client={client}
        project={selectedProject}
        notify={notify}
        openTask={(key) => onTask(selectedProject.code, key)}
        onExit={() => onRoute("projects")}
        onKnowledgeDraft={async (recordKey) => {
          try {
            const preview = await client.knowledge.previewRecord(selectedProject.code, recordKey);
            onKnowledgeDraft({
              title: preview.title,
              summary: preview.summary,
              bodyMarkdown: preview.bodyMarkdown,
              sourceRefs: [preview.sourceRef],
            });
            onRoute("knowledge");
          } catch (error) {
            notify(
              `无法载入 Record 来源：${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }}
        {...(desktop ? { desktop } : {})}
      />
    );
  return <ErrorState error="找不到这个项目，可能已被移除或路径发生变化。" />;
}

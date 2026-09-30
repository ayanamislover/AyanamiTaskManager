import type { ReactNode } from "react";
import type { AyanamiClient, RegisteredProject } from "@ayanami-task/client";
import {
  ErrorState,
  LoadingRows,
  PageHead,
  ProjectsUnavailable,
} from "../components/async-state.js";
import type { DesktopBridge, Notify, Route } from "../contracts.js";
import { AgentsLoading, AgentsPage } from "../features/agents.js";
import { OverviewPage, TasksAcrossProjects } from "../features/overview.js";
import { ProjectPage } from "../features/project.js";
import { ProjectsPage } from "../features/projects.js";
import { QuickPage } from "../features/quick.js";
import { SettingsPage } from "../features/settings.js";
import { GlobalTimelinePage, TimelineEventRow } from "../features/timeline.js";
import { KnowledgePage, type KnowledgeDraftSeed } from "../features/knowledge.js";
import { RouteStage, type RouteStageSlot } from "./route-stage.js";

type AppRouterProps = {
  client: AyanamiClient;
  desktop: DesktopBridge | undefined;
  route: Route;
  projects: RegisteredProject[];
  /** 项目列表还没拿到（在读，或读失败了）：这时的空数组不是「没有项目」。 */
  projectsPending: boolean;
  /** 项目列表读失败、眼下也没在重读：依赖它的页面显示失败和重试，不下「没有」的结论。 */
  projectsError: unknown;
  onRetryProjects: () => void;
  notify: Notify;
  onRoute: (route: Route) => void;
  onTask: (project: string, key: string) => void;
  knowledgeDraft: KnowledgeDraftSeed | null;
  onKnowledgeDraft: (draft: KnowledgeDraftSeed) => void;
  onKnowledgeDraftConsumed: () => void;
};

/** 项目列表还在读时，项目页的舞台 key 带上这个后缀，渲染成加载占位。 */
const AWAITING_PROJECTS = "\u0000awaiting-projects";

/**
 * 切项目时让新项目页先在后台读完首屏再换上（见 RouteStage）；其他页面照旧立即切换。
 *
 * 冷启动直接打开项目页时，项目列表还没回来，先显示占位；列表回来后舞台 key 变了，
 * 和切项目走同一条路：占位留在前面，项目页在后台读齐首屏再换上。否则项目页一挂载
 * 就先画一帧「没有进行中任务」之类的空态，再换骨架，再逐块长出来。
 */
export function AppRouter(props: AppRouterProps): ReactNode {
  const isProject = props.route.startsWith("project:");
  const stageKey =
    isProject && props.projectsPending ? props.route + AWAITING_PROJECTS : props.route;
  return (
    <RouteStage
      route={stageKey}
      defer={isProject}
      render={(key, stage) => {
        const awaiting = key.endsWith(AWAITING_PROJECTS);
        const route = (awaiting ? key.slice(0, -AWAITING_PROJECTS.length) : key) as Route;
        // 项目页的占位只看自己的 key：换上前它还留在前面当预览，不能跟着 props 变成真页面。
        const projectsPending = route.startsWith("project:") ? awaiting : props.projectsPending;
        return routePage({ ...props, route, projectsPending }, stage);
      }}
    />
  );
}

function routePage(
  {
    client,
    desktop,
    route,
    projects,
    projectsPending,
    projectsError,
    onRetryProjects,
    notify,
    onRoute,
    onTask,
    knowledgeDraft,
    onKnowledgeDraft,
    onKnowledgeDraftConsumed,
  }: AppRouterProps,
  stage: RouteStageSlot,
): ReactNode {
  // 项目列表还在读（或这一层是等列表时的占位）：找不到不等于项目没了，找到了也先不渲染。
  const selectedProject =
    route.startsWith("project:") && !projectsPending
      ? projects.find((project) => project.code === route.slice(8))
      : undefined;
  const awaitingProjects = projectsError ? (
    <ProjectsUnavailable error={projectsError} onRetry={onRetryProjects} />
  ) : (
    <LoadingRows count={6} />
  );
  if (route === "overview")
    return (
      <OverviewPage
        client={client}
        onProject={(code) => onRoute(`project:${code}`)}
        onQuick={() => onRoute("quick")}
        notify={notify}
        TimelineEventRow={TimelineEventRow}
        onTask={onTask}
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
        {projectsPending ? (
          awaitingProjects
        ) : (
          <TasksAcrossProjects client={client} projects={projects} mode="active" onTask={onTask} />
        )}
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
        {projectsPending ? (
          awaitingProjects
        ) : (
          <TasksAcrossProjects client={client} projects={projects} mode="blocked" onTask={onTask} />
        )}
      </>
    );
  if (route === "agents")
    return projectsPending ? (
      <AgentsLoading>{projectsError ? awaitingProjects : undefined}</AgentsLoading>
    ) : (
      <AgentsPage client={client} projects={projects} />
    );
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
    return (
      <SettingsPage
        client={client}
        notify={notify}
        {...(desktop === undefined ? {} : { desktop })}
      />
    );
  if (selectedProject)
    return (
      <ProjectPage
        client={client}
        project={selectedProject}
        stage={stage}
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
  if (projectsPending) return awaitingProjects;
  return <ErrorState error="找不到这个项目，可能已被移除或路径发生变化。" />;
}

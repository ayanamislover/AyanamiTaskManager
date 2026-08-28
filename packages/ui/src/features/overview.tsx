import type { ComponentType } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon as Plus } from "@phosphor-icons/react/dist/icons/Plus";
import { WarningCircleIcon as WarningCircle } from "@phosphor-icons/react/dist/icons/WarningCircle";
import type { AyanamiClient, RegisteredProject } from "@ayanami-task/client";
import {
  CursorLoadStatus,
  Empty,
  ErrorState,
  LoadingRows,
  PageHead,
} from "../components/async-state.js";
import type { Notify } from "../contracts.js";
import { useCursorCollections } from "../cursor-collection.js";
import { ProjectionStatusBadge } from "../projection-health-panel.js";
import { Status, formatTime, progressSourceLabels, sidebarProjectHint } from "../presentation.js";
import { presentTimelineEvent } from "../timeline-events.js";

export function OverviewPage({
  client,
  onProject,
  onQuick,
  notify,
  TimelineEventRow,
}: {
  client: AyanamiClient;
  onProject: (code: string) => void;
  onQuick: () => void;
  notify: Notify;
  TimelineEventRow: ComponentType<{ event: Record<string, unknown> }>;
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
  const projects = data.projects.filter((project) => project.lifecycle !== "TRASHED");
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
  for (const failure of data.projectionFailures ?? []) {
    const code = failure.project.code;
    if (failure.reason === "MISSING") attention.push(`${code} 缺少数据投影状态`);
    else if (failure.reason === "INVERTED")
      attention.push(`${code} 数据投影序列倒挂（lag ${failure.lag}）`);
    else attention.push(`${code} 数据投影等待重试（lag ${failure.lag}）`);
  }
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
                  title={sidebarProjectHint(project.name)}
                  onClick={() => onProject(project.code)}
                >
                  <div className="atm-actions" style={{ justifyContent: "space-between" }}>
                    <span className="atm-project-code">{project.code}</span>
                    <Status value={project.health ?? "UNKNOWN"} />
                  </div>
                  <h2 className="atm-overview-project-name">{project.name}</h2>
                  <div className="atm-row-sub">
                    {project.current_milestone ?? "尚未设置里程碑"} ·{" "}
                    {project.next_target_date ?? "无目标日期"}
                  </div>
                  <div className="atm-progress">
                    <span style={{ width: `${Number(project.progress ?? 0)}%` }} />
                  </div>
                  <div className="atm-row-sub">
                    {Math.round(Number(project.progress ?? 0))}% ·{" "}
                    {progressSourceLabels[String(project.progress_source ?? "NONE")] ?? "尚无进度"}
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
                  <div className="atm-projection-summary">
                    <ProjectionStatusBadge status={project.projection?.status ?? "MISSING"} />
                    <span className="atm-row-sub">lag {project.projection?.lag ?? "—"}</span>
                  </div>
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

function useAllProjectTasks(client: AyanamiClient, projects: RegisteredProject[]) {
  const sources = projects
    .filter((project) => project.lifecycle === "ACTIVE")
    .map((project) => ({
      key: project.code,
      loadPage: (cursor?: string) =>
        client.tasks.pageForUi(project.code, {
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        }),
    }));
  return useCursorCollections(
    ["tasks", "all", "ui", ...sources.map((source) => source.key)],
    sources,
  );
}

export function TasksAcrossProjects({
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
  const collection = useAllProjectTasks(client, projects);
  const entries = Object.values(collection.entries);
  const isLoading = entries.some((entry) => entry.isLoading);
  const errorEntry = entries.find((entry) => entry.error);
  const error = errorEntry?.error;
  const loadedCount = entries.reduce((total, entry) => total + entry.loadedCount, 0);
  if (isLoading && loadedCount === 0) return <LoadingRows count={6} />;
  if (error && loadedCount === 0)
    return (
      <>
        <CursorLoadStatus
          loadedCount={loadedCount}
          hasMore={false}
          error={error}
          onRetry={() => (errorEntry ? void collection.retry(errorEntry.key) : undefined)}
        />
        <ErrorState error={error} />
      </>
    );
  const statuses =
    mode === "active"
      ? ["CLAIMED", "IN_PROGRESS", "VERIFYING"]
      : ["BLOCKED", "WAITING_USER", "WAITING_AGENT"];
  const tasks = entries
    .flatMap((entry) => entry.items.map((task: any) => ({ ...task, project: entry.key })))
    .map((task: any) => ({
      ...task,
      projectName: projects.find((project) => project.code === task.project)?.name ?? task.project,
    }))
    .filter((task: any) => statuses.includes(task.status));
  if (!tasks.length)
    return (
      <>
        <CursorLoadStatus
          loadedCount={loadedCount}
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
          <Empty
            title={mode === "active" ? "没有活动任务" : "没有阻塞或等待"}
            text={
              mode === "active"
                ? "任务被领取或开始后会出现在这里。"
                : "当前没有需要外部处理的任务。"
            }
          />
        </section>
      </>
    );
  return (
    <>
      <CursorLoadStatus
        loadedCount={loadedCount}
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
              <tr key={task.key} onClick={() => onTask(task.project, task.key)}>
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
    </>
  );
}

import { useQuery } from "@tanstack/react-query";
import { ArrowRightIcon as ArrowRight } from "@phosphor-icons/react/dist/icons/ArrowRight";
import type { AyanamiClient } from "@ayanami-task/client";
import { Empty } from "../components/async-state.js";
import type { Notify } from "../contracts.js";
import {
  Status,
  compactPath,
  formatTime,
  priorityLabels,
  progressSourceLabels,
  statusLabels,
} from "../presentation.js";
import { ProjectProjectionPanel } from "../projection-health-panel.js";
import { EngineeringMetricsPanel } from "../project-statistics-panel.js";
import { ProjectReconcile } from "./project-reconcile.js";

export function ProjectSummary({
  client,
  projectCode,
  workItems,
  notify,
  openTask,
}: {
  client: AyanamiClient;
  projectCode: string;
  workItems: any[];
  notify: Notify;
  openTask: (key: string) => void;
}) {
  const brief = useQuery({
    queryKey: ["brief", projectCode],
    queryFn: () => client.projects.brief(projectCode),
  });
  const overview = useQuery({
    queryKey: ["overview"],
    queryFn: () => client.overview(),
  });
  const agents = useQuery({
    queryKey: ["agents", projectCode],
    queryFn: () => client.projects.agents(projectCode),
  });
  const updates = useQuery({
    queryKey: ["project-updates", projectCode],
    queryFn: () => client.projects.updates(projectCode),
  });
  const projectSummary = ((overview.data?.projects ?? []) as any[]).find(
    (candidate) => candidate.code === projectCode,
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

  return (
    <>
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
        projectCode={projectCode}
        state={projectSummary?.projection ?? null}
        notify={notify}
      />
      <ProjectReconcile client={client} projectCode={projectCode} openTask={openTask} />
      <EngineeringMetricsPanel
        client={client}
        projectCode={projectCode}
        formatCapturedAt={formatTime}
      />
    </>
  );
}

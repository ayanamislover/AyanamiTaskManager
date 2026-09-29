import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRightIcon as ArrowRight } from "@phosphor-icons/react/dist/icons/ArrowRight";
import type { AyanamiClient } from "@ayanami-task/client";
import { Empty, LoadingRows } from "../components/async-state.js";
import {
  Status,
  compactPath,
  formatTime,
  priorityLabels,
  progressSourceLabels,
  statusLabels,
} from "../presentation.js";
import { ProjectProgressStrip } from "./project-progress-strip.js";

/**
 * 项目页主体：指标卡在上，任务列表（children）紧跟其后，管理摘要卡放在列表下面。
 * 以前任务列表排在指标卡、四张管理卡、数据投影、对账、工程统计之后，1280 宽要往下滚
 * 约 1300px 才看得到；排障面板已移到 ProjectDiagnostics。
 */
export function ProjectSummary({
  client,
  projectCode,
  workItems,
  tasksLoading = false,
  openTask,
  children,
}: {
  client: AyanamiClient;
  projectCode: string;
  workItems: any[];
  /** 任务首屏还没读回来：下面几张卡显示加载态，不能先说「没有进行中任务」。 */
  tasksLoading?: boolean;
  openTask: (key: string) => void;
  children?: ReactNode;
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
  // 还没读回来就显示占位，不先说「尚未设置」：那是一句关于项目的断言，读回来再改口就是闪一下。
  const briefValue = (value: unknown) => (brief.isPending ? PENDING : String(value ?? "尚未设置"));
  const tasksCount = (count: number) => (tasksLoading ? PENDING : count);

  return (
    <>
      <section className="atm-metrics five">
        <div className="atm-metric">
          <div className="label">当前目标</div>
          <div style={{ marginTop: 12, fontWeight: 650 }}>{briefValue(brief.data?.objective)}</div>
        </div>
        <div className="atm-metric">
          <div className="label">当前里程碑</div>
          <div style={{ marginTop: 12, fontWeight: 650 }}>{briefValue(brief.data?.milestone)}</div>
        </div>
        <div className="atm-metric">
          <div className="label">健康度</div>
          <div style={{ marginTop: 12 }}>
            {overview.isPending ? (
              PENDING
            ) : (
              <Status value={String(projectSummary?.health ?? "UNKNOWN")} />
            )}
          </div>
          <div className="detail">
            最近活动 {overview.isPending ? PENDING : formatTime(projectSummary?.last_activity_at)}
          </div>
        </div>
        <div className="atm-metric">
          <div className="label">项目进度</div>
          <div className="value">
            {overview.isPending ? PENDING : `${Math.round(Number(projectSummary?.progress ?? 0))}%`}
          </div>
          <div className="detail">
            {overview.isPending
              ? PENDING
              : (progressSourceLabels[String(projectSummary?.progress_source ?? "NONE")] ??
                "尚无进度")}
          </div>
        </div>
        <div className="atm-metric">
          <div className="label">下一目标日期</div>
          <div style={{ marginTop: 12, fontWeight: 650 }}>
            {overview.isPending ? PENDING : String(projectSummary?.next_target_date ?? "尚未设置")}
          </div>
          <div className="detail">
            项目更新{" "}
            {overview.isPending ? PENDING : formatTime(projectSummary?.last_project_update_at)}
          </div>
        </div>
      </section>
      <ProjectProgressStrip client={client} projectCode={projectCode} />
      {children}
      <section className="atm-management-grid atm-project-management" aria-label="项目管理摘要">
        <article className="atm-panel atm-management-card">
          <div className="atm-panel-head">
            <h2>当前进行</h2>
            <span className="atm-badge primary">{tasksCount(inProgress.length)}</span>
          </div>
          {tasksLoading ? (
            <LoadingRows count={2} />
          ) : inProgress.length ? (
            <div className="atm-list">
              {inProgress.map((task) => (
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
            <span
              className={`atm-badge ${tasksLoading ? "" : blockers.length ? "danger" : "success"}`}
            >
              {tasksCount(blockers.length)}
            </span>
          </div>
          {tasksLoading ? (
            <LoadingRows count={2} />
          ) : blockers.length ? (
            <div className="atm-list">
              {blockers.map((task) => (
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
            <span className="atm-badge">
              在线 {agents.isPending ? PENDING : onlineAgents.length}
            </span>
          </div>
          <div className="atm-panel-body">
            <div className="atm-row-title">{tasksCount(claimedCount)} 项任务已领取</div>
            <div className="atm-row-sub">
              {agents.isPending
                ? PENDING
                : onlineAgents.length
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
            <div className="atm-row-title">
              {updates.isPending ? PENDING : (latestUpdate?.summary ?? "尚未发布项目更新")}
            </div>
            <div className="atm-row-sub">
              {updates.isPending
                ? PENDING
                : latestUpdate
                  ? `${statusLabels[latestUpdate.health] ?? latestUpdate.health} · ${formatTime(latestUpdate.publishedAt)}`
                  : "发布后会形成可追溯的项目判断"}
            </div>
          </div>
        </article>
        <article className="atm-panel atm-management-card">
          <div className="atm-panel-head">
            <h2>下一步</h2>
            <span className="atm-badge">可开始 {tasksCount(ready.length)}</span>
          </div>
          {tasksLoading ? (
            <LoadingRows count={2} />
          ) : ready.length ? (
            <div className="atm-list">
              {ready.map((task) => (
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
    </>
  );
}

/** 读取中的占位：一个破折号，不是「0」也不是「尚未设置」。 */
const PENDING = "—";

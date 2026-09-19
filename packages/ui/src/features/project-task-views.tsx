import type { ReactNode } from "react";
import { GitBranchIcon as GitBranch } from "@phosphor-icons/react/dist/icons/GitBranch";
import type { CursorCollection } from "../cursor-collection.js";
import { CursorLoadStatus, Empty, ErrorState, LoadingRows } from "../components/async-state.js";
import { taskRowInteractionProps } from "../components/keyboard-interactions.js";
import { formatTime, priorityLabels, Status } from "../presentation.js";
import { presentTimelineEvent } from "../timeline-events.js";
import type { ProjectTaskSort, ProjectTaskSortField } from "../task-sort.js";
import { SystemEventsToggle, TimelineEventRow, useTimelineEvents } from "./timeline.js";
import {
  ProjectTaskSortHeader,
  taskTreeRows,
  type ProjectTaskView,
} from "./project-task-controls.js";
import type { RecentClosedTasks } from "./recent-closed-tasks.js";

type ProjectEventsState = {
  isLoading: boolean;
  data: { events?: unknown[] } | undefined;
};

export function ProjectTaskViews({
  view,
  tasks,
  records,
  events,
  filteredTasks,
  sortedTasks,
  closedRows = [],
  closedTasks,
  taskSort,
  onTaskSort,
  onOpenTask,
  onExtractKnowledge,
}: {
  view: ProjectTaskView;
  tasks: CursorCollection<any>;
  records: CursorCollection<any>;
  events: ProjectEventsState;
  filteredTasks: any[];
  sortedTasks: any[];
  closedRows?: any[];
  closedTasks?: RecentClosedTasks;
  taskSort: ProjectTaskSort | null;
  onTaskSort: (field: ProjectTaskSortField) => void;
  onOpenTask: (key: string) => void;
  onExtractKnowledge?: (recordKey: string) => void | Promise<void>;
}) {
  const timeline = useTimelineEvents((events.data?.events ?? []) as Record<string, unknown>[]);
  const content = () => {
    if (tasks.isLoading && tasks.items.length === 0) return <LoadingRows count={6} />;
    if (tasks.error && tasks.items.length === 0)
      return (
        <>
          <ErrorState error={tasks.error} />
          <button className="atm-button" onClick={() => void tasks.retry()}>
            重试加载
          </button>
        </>
      );
    if (view === "records") {
      if (records.isLoading && records.items.length === 0) return <LoadingRows />;
      if (records.error && records.items.length === 0)
        return (
          <>
            <CursorLoadStatus
              loadedCount={records.items.length}
              hasMore={false}
              error={records.error}
              onRetry={() => void records.retry()}
            />
            <ErrorState error={records.error} />
          </>
        );
      return records.items.length ? (
        <>
          <CursorLoadStatus
            loadedCount={records.items.length}
            hasMore={records.hasMore}
            loading={records.isFetchingNextPage}
            error={records.error}
            onRetry={() => void records.retry()}
          />
          <div className="atm-list">
            {records.items.map((record: any) => (
              <article className="atm-record" key={record.id}>
                <div className="atm-actions" style={{ justifyContent: "space-between" }}>
                  <span className="atm-badge">
                    {(
                      {
                        DECISION: "决策",
                        CONSTRAINT: "约束",
                        FACT: "事实",
                        RISK: "风险",
                        REFERENCE: "参考",
                        LESSON: "经验",
                        VERIFICATION: "验证",
                        WAIVER: "豁免",
                      } as Record<string, string>
                    )[record.kind] ?? record.kind}
                  </span>
                  <span className="atm-row-sub">
                    {record.sourceType === "USER"
                      ? "用户"
                      : record.sourceType === "AGENT"
                        ? "Agent"
                        : record.sourceType === "IMPORT"
                          ? "导入"
                          : "系统"}{" "}
                    · {formatTime(record.updatedAt)}
                  </span>
                </div>
                <h3>{record.title}</h3>
                {record.topic ? <div className="atm-key">主题：{record.topic}</div> : null}
                {record.subjectKey ? (
                  <div className="atm-key">主题标识：{record.subjectKey}</div>
                ) : null}
                <p>{record.summary}</p>
                {record.relatedRecords.length ? (
                  <div className="atm-row-sub">相关记录：{record.relatedRecords.join("、")}</div>
                ) : null}
                {record.detail ? (
                  <details>
                    <summary>查看详情</summary>
                    <div className="atm-description">{record.detail}</div>
                  </details>
                ) : null}
                {onExtractKnowledge ? (
                  <div className="atm-actions" style={{ marginTop: 10 }}>
                    <button
                      className="atm-button"
                      type="button"
                      onClick={() => void onExtractKnowledge(record.key)}
                    >
                      提炼为共享知识草稿
                    </button>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        </>
      ) : (
        <>
          <CursorLoadStatus loadedCount={0} hasMore={false} />
          <Empty title="还没有项目记录" text="把决策、约束、风险和验证保存为持久上下文。" />
        </>
      );
    }
    if (view === "timeline") {
      if (events.isLoading) return <LoadingRows />;
      const rows = timeline.visible;
      return (
        <>
          <div className="atm-timeline-toolbar">
            <SystemEventsToggle checked={timeline.showSystem} onChange={timeline.setShowSystem} />
          </div>
          {rows.length ? (
            <div className="atm-timeline">
              {rows
                .slice()
                .reverse()
                .map((event) => {
                  const item = presentTimelineEvent(event);
                  return <TimelineEventRow event={event} key={item.id} />;
                })}
            </div>
          ) : (
            <Empty
              title="没有项目事件"
              text={
                timeline.hiddenCount
                  ? `只有 ${timeline.hiddenCount} 条系统事件，勾选「显示系统事件」查看。`
                  : "任务发生变化后会显示在这里。"
              }
            />
          )}
        </>
      );
    }
    if (!filteredTasks.length) return <Empty title="没有匹配任务" text="调整筛选或创建任务。" />;
    if (view === "board") {
      const columns = [
        ["待开始", ["BACKLOG", "READY"]],
        ["进行中", ["CLAIMED", "IN_PROGRESS"]],
        ["受阻", ["BLOCKED", "WAITING_USER", "WAITING_AGENT"]],
        ["验收与完成", ["VERIFYING", "DONE"]],
      ] as const;
      return (
        <div className="atm-board">
          {columns.map(([label, states]) => (
            <section className="atm-column" key={label}>
              <div className="atm-column-head">
                <span>{label}</span>
                <span className="atm-key">
                  {
                    filteredTasks.filter((task: any) => states.includes(task.status as never))
                      .length
                  }
                </span>
              </div>
              {filteredTasks
                .filter((task: any) => states.includes(task.status as never))
                .map((task: any) => (
                  <button
                    className="atm-task-card"
                    key={task.id}
                    onClick={() => onOpenTask(task.key)}
                  >
                    <div className="atm-row-title">{task.title}</div>
                    <div className="atm-row-sub">
                      {task.key} · {Math.round(task.progress ?? 0)}%
                    </div>
                  </button>
                ))}
            </section>
          ))}
        </div>
      );
    }
    if (view === "tree") {
      const row = (task: any, depth: number): ReactNode => (
        <button
          key={task.id}
          className="atm-tree-row"
          style={{
            width: "100%",
            paddingLeft: 12 + depth * 22,
            borderTop: 0,
            borderRight: 0,
            borderLeft: 0,
            background: "transparent",
            textAlign: "left",
          }}
          onClick={() => onOpenTask(task.key)}
        >
          <GitBranch size={15} />
          <span className="atm-key">{task.key}</span>
          <span className="atm-row-title" style={{ flex: 1 }}>
            {task.title}
          </span>
          {task.discoveredFrom ? (
            <span className="atm-badge" title={`工作中发现于 ${task.discoveredFrom}`}>
              发现于 {task.discoveredFrom}
            </span>
          ) : null}
          {task.discoveredCount ? (
            <span className="atm-badge" title={`工作中发现 ${task.discoveredCount} 项`}>
              发现 {task.discoveredCount}
            </span>
          ) : null}
          <Status value={task.status} />
        </button>
      );
      return (
        <div className="atm-tree">
          {taskTreeRows(filteredTasks).map(({ task, depth }) => row(task, depth))}
        </div>
      );
    }
    return (
      <table className="atm-table">
        {/* 比例定死，窗口变窄时一起等比缩，而不是让任务列把别人挤没。
            数值按 1366 宽下的实测下限定：可排序表头自带图标，「更新时间」表头
            本身就要 76px、「优先级」要 65px，比单元格文本更吃宽度。 */}
        <colgroup>
          <col style={{ width: "27%" }} />
          <col style={{ width: "9%" }} />
          <col style={{ width: "9%" }} />
          <col style={{ width: "11%" }} />
          <col style={{ width: "7%" }} />
          <col style={{ width: "9%" }} />
          <col style={{ width: "12%" }} />
          <col style={{ width: "5%" }} />
          <col style={{ width: "11%" }} />
        </colgroup>
        <thead>
          <tr>
            <ProjectTaskSortHeader field="task" label="任务" sort={taskSort} onSort={onTaskSort} />
            <ProjectTaskSortHeader
              field="status"
              label="状态"
              sort={taskSort}
              onSort={onTaskSort}
            />
            <ProjectTaskSortHeader
              field="priority"
              label="优先级"
              sort={taskSort}
              onSort={onTaskSort}
            />
            <th>负责人</th>
            <th>层级</th>
            <th>阻塞 / 等待</th>
            <th>进度</th>
            <ProjectTaskSortHeader
              field="updatedAt"
              label="更新时间"
              sort={taskSort}
              onSort={onTaskSort}
            />
          </tr>
        </thead>
        <tbody>{sortedTasks.map(taskRow)}</tbody>
        {closedRows.length ? (
          <tbody className="atm-closed-tasks">
            <tr className="atm-table-section">
              <th colSpan={8} scope="rowgroup">
                最近结束
                {closedTasks ? (
                  <span className="atm-row-sub">
                    显示 {closedRows.length} / {closedTasks.total} 项
                  </span>
                ) : null}
              </th>
            </tr>
            {closedRows.map(taskRow)}
          </tbody>
        ) : null}
      </table>
    );
  };
  const taskRow = (task: any) => (
    <tr
      key={task.id}
      {...taskRowInteractionProps(`打开任务 ${task.key}：${task.title}`, () =>
        onOpenTask(task.key),
      )}
    >
      <td>
        <div className="atm-row-title">{task.title}</div>
        <span className="atm-key">{task.key}</span>
      </td>
      <td>
        <Status value={task.status} />
      </td>
      <td>{priorityLabels[task.priority] ?? task.priority}</td>
      <td>{task.assigneeAgentId === "USER" ? "桌面用户" : (task.assigneeAgentId ?? "未分配")}</td>
      <td className="atm-key">{task.parentId ? "子任务" : "根任务"}</td>
      <td>
        <span className="atm-cell-wrap">{task.blockedReason || task.waitingFor || "—"}</span>
      </td>
      <td className="atm-key">{Math.round(task.progress ?? 0)}%</td>
      <td>{formatTime(task.updatedAt)}</td>
    </tr>
  );
  const showsTasks = view === "list" || view === "board" || view === "tree";
  const remainingClosed = closedTasks
    ? Math.max(0, closedTasks.total - closedTasks.items.length)
    : 0;
  return (
    <>
      {/* 全部读完且没出错时不再显示「已加载 N 项，已全部加载」：那是噪声，不是信息。 */}
      {tasks.error || tasks.isFetchingNextPage ? (
        <CursorLoadStatus
          loadedCount={tasks.loadedCount}
          hasMore={tasks.hasMore}
          loading={tasks.isFetchingNextPage}
          error={tasks.error}
          onRetry={() => void tasks.retry()}
        />
      ) : null}
      <section
        className="atm-panel"
        role="tabpanel"
        id="project-task-panel"
        aria-labelledby={`project-task-tab-${view}`}
      >
        {content()}
        {showsTasks && closedTasks && (closedTasks.hasMore || closedTasks.error) ? (
          <div className="atm-closed-more">
            {closedTasks.error ? (
              <span className="atm-inline-error" role="alert">
                已结束任务加载失败
              </span>
            ) : (
              <span className="atm-row-sub">还有 {remainingClosed} 项已结束任务未加载</span>
            )}
            <button
              className="atm-button"
              type="button"
              disabled={closedTasks.isFetchingMore}
              onClick={closedTasks.loadMore}
            >
              {closedTasks.isFetchingMore
                ? "正在加载…"
                : closedTasks.error
                  ? "重试"
                  : "加载更多已结束任务"}
            </button>
          </div>
        ) : null}
      </section>
    </>
  );
}

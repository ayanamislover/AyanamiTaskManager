import { useRef, useState } from "react";
import { CheckCircleIcon as CheckCircle } from "@phosphor-icons/react/dist/icons/CheckCircle";
import { PlusIcon as Plus } from "@phosphor-icons/react/dist/icons/Plus";
import { RobotIcon as Robot } from "@phosphor-icons/react/dist/icons/Robot";
import type { TaskCard as Task } from "@ayanami-task/sync-protocol";
import { groupTasks, type TaskGroup } from "../data/snapshot.js";
import { formatRelative } from "../data/time.js";
import { useEngine, useEngineState, useNow } from "../ui/hooks.js";
import { priorityLabel } from "../ui/labels.js";
import { OfflineNote } from "../ui/offline-note.js";
import {
  DispatchBadge,
  EmptyState,
  IconButton,
  Progress,
  Screen,
  SectionTitle,
  StatusBadge,
} from "../ui/layout.js";
import { push } from "../ui/nav.js";
import { usePullToRefresh } from "../ui/pull-refresh.js";

const DONE_PREVIEW = 5;

export function ProjectScreen({ code }: { code: string }) {
  const engine = useEngine();
  const state = useEngineState();
  const now = useNow();
  const scrollRef = useRef<HTMLDivElement>(null);
  const indicator = usePullToRefresh(scrollRef, state.refreshing, () => engine.refresh());
  const head = state.snapshot.head?.projects.find((project) => project.code === code);
  const doc = state.snapshot.projects[code]?.doc;
  const groups = doc ? groupTasks(doc.tasks) : [];
  const openCount = groups
    .filter((g) => g.id !== "done")
    .reduce((sum, g) => sum + g.tasks.length, 0);

  return (
    <Screen
      className="project-screen"
      scrollRef={scrollRef}
      overlay={indicator}
      title={head?.name ?? doc?.name ?? code}
      subtitle={<span className="mono">{code}</span>}
      actions={
        <IconButton label="在这个项目里新建任务" onClick={() => push({ name: "new", code })}>
          <Plus size={20} weight="bold" aria-hidden="true" />
        </IconButton>
      }
    >
      <OfflineNote />
      {!doc ? (
        head ? (
          <div className="skeleton-list" aria-label="正在载入">
            <span className="skeleton" />
            <span className="skeleton" />
          </div>
        ) : (
          <EmptyState
            icon={<CheckCircle size={26} weight="duotone" />}
            title="电脑上已经没有这个项目"
          >
            可能被归档或移到了垃圾箱。
          </EmptyState>
        )
      ) : openCount === 0 && groups.every((g) => g.tasks.length === 0) ? (
        <EmptyState icon={<CheckCircle size={26} weight="duotone" />} title="这个项目还没有任务">
          点右上角的 + 从手机发一个上去。
        </EmptyState>
      ) : (
        <>
          {openCount === 0 ? (
            <EmptyState icon={<CheckCircle size={26} weight="duotone" />} title="没有未完成的任务">
              最近完成的在下面。
            </EmptyState>
          ) : null}
          {groups.map((group) =>
            group.tasks.length > 0 ? (
              <Group key={group.id} group={group} code={code} now={now} />
            ) : null,
          )}
        </>
      )}
    </Screen>
  );
}

function Group({ group, code, now }: { group: TaskGroup; code: string; now: number }) {
  const [expanded, setExpanded] = useState(false);
  const done = group.id === "done";
  const shown = done && !expanded ? group.tasks.slice(0, DONE_PREVIEW) : group.tasks;
  return (
    <section className="task-group" data-group={group.id}>
      <SectionTitle count={group.tasks.length}>{group.label}</SectionTitle>
      <div className="task-list">
        {shown.map((task) =>
          done ? (
            <DoneRow key={task.key} task={task} code={code} now={now} />
          ) : (
            <TaskCardView key={task.key} task={task} code={code} now={now} />
          ),
        )}
      </div>
      {done && group.tasks.length > DONE_PREVIEW ? (
        <button
          type="button"
          className="text-button more-button"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "收起" : `显示全部 ${group.tasks.length} 条`}
        </button>
      ) : null}
    </section>
  );
}

function TaskCardView({ task, code, now }: { task: Task; code: string; now: number }) {
  const note =
    task.status === "BLOCKED"
      ? task.blocked
      : task.status.startsWith("WAITING")
        ? task.waiting
        : null;
  const showProgress =
    task.progress > 0 || task.status === "IN_PROGRESS" || task.status === "VERIFYING";
  return (
    <button
      type="button"
      className="card task-card"
      onClick={() => push({ name: "task", code, key: task.key })}
    >
      <span className="task-card-head">
        <span className="task-key">{task.key}</span>
        {task.priority === "HIGH" || task.priority === "CRITICAL" ? (
          <span className="priority-flag" data-priority={task.priority}>
            {priorityLabel(task.priority)}
          </span>
        ) : null}
        <StatusBadge status={task.status} />
      </span>
      <strong className="task-title">{task.title}</strong>
      {note ? (
        <span className="task-note" data-status={task.status}>
          {note}
        </span>
      ) : null}
      {showProgress ? (
        <span className="task-progress">
          <Progress value={task.progress} />
          <span className="task-percent">{Math.round(task.progress)}%</span>
        </span>
      ) : null}
      <span className="task-meta">
        {task.claim ? (
          <span className="task-agent">
            <Robot size={15} weight="duotone" aria-hidden="true" />
            <span>{task.claim.agent}</span>
          </span>
        ) : (
          <span className="task-agent is-empty">未领取</span>
        )}
        {task.dispatch ? (
          <DispatchBadge dispatch={task.dispatch} />
        ) : (
          <span className="task-time">{formatRelative(task.updatedAt, now)}</span>
        )}
      </span>
    </button>
  );
}

function DoneRow({ task, code, now }: { task: Task; code: string; now: number }) {
  return (
    <button
      type="button"
      className="done-row"
      onClick={() => push({ name: "task", code, key: task.key })}
    >
      <span className="done-check" data-status={task.status} aria-hidden="true">
        <CheckCircle size={18} weight="fill" />
      </span>
      <span className="done-copy">
        <span className="done-title">{task.title}</span>
        <span className="done-meta">
          <span className="task-key">{task.key}</span>
          {task.status === "CANCELLED" ? <span>已取消</span> : null}
        </span>
      </span>
      <span className="task-time">{formatRelative(task.updatedAt, now)}</span>
    </button>
  );
}

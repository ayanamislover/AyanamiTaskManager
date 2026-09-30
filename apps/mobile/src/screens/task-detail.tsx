import { useState } from "react";
import { ClockIcon as Clock } from "@phosphor-icons/react/dist/icons/Clock";
import { HourglassMediumIcon as Hourglass } from "@phosphor-icons/react/dist/icons/HourglassMedium";
import { MagnifyingGlassIcon as MagnifyingGlass } from "@phosphor-icons/react/dist/icons/MagnifyingGlass";
import { ProhibitIcon as Prohibit } from "@phosphor-icons/react/dist/icons/Prohibit";
import { RobotIcon as Robot } from "@phosphor-icons/react/dist/icons/Robot";
import { SparkleIcon as Sparkle } from "@phosphor-icons/react/dist/icons/Sparkle";
import { WarningCircleIcon as WarningCircle } from "@phosphor-icons/react/dist/icons/WarningCircle";
import type { TaskCard } from "@ayanami-task/sync-protocol";
import { findTask } from "../data/snapshot.js";
import { formatClock, formatRelative } from "../data/time.js";
import { useEngine, useEngineState, useNow } from "../ui/hooks.js";
import {
  DISPATCH_LABELS,
  dispatchAwaitingSnapshot,
  dispatchBlocker,
  dispatchFailureReason,
  dispatchTone,
  priorityLabel,
  typeLabel,
} from "../ui/labels.js";
import { EmptyState, Progress, Screen, StatusBadge, ToneBadge } from "../ui/layout.js";
import { OfflineNote } from "../ui/offline-note.js";
import { CommandCard } from "./outbox.js";

const LONG_DESCRIPTION = 180;

export function TaskScreen({ code, taskKey }: { code: string; taskKey: string }) {
  const engine = useEngine();
  const state = useEngineState();
  const now = useNow();
  const task = findTask(state.snapshot, code, taskKey);
  const dispatchEnabled = state.snapshot.head?.dispatch.enabled;
  // 电脑已接下、但快照还停在上一次派单（例如上次 failed）的命令也算在途：按钮保持不可点，免得连发两次。
  const pending = state.commands.filter(
    (command) =>
      command.doc.type === "task.dispatch" &&
      command.doc.body.key === taskKey &&
      !command.dismissed &&
      (command.state === "pending" ||
        command.state === "sent" ||
        command.state === "failed" ||
        dispatchAwaitingSnapshot(command, taskKey, task)),
  );
  const waitingForAck = pending.some(
    (command) => command.state === "pending" || command.state === "sent",
  );
  const handedOff = pending.some((command) => command.state === "created");
  const blocker = task
    ? handedOff
      ? "已经交给 Claude 了"
      : dispatchBlocker(task, dispatchEnabled)
    : null;
  const retry = task?.dispatch?.state === "failed";
  const retryHasReason = Boolean(task && dispatchFailureReason(null, task));
  const [sending, setSending] = useState(false);

  const send = async () => {
    if (!task || blocker || waitingForAck) return;
    setSending(true);
    try {
      await engine.submit({ type: "task.dispatch", body: { project: code, key: task.key } });
    } finally {
      setSending(false);
    }
  };

  const closed = task?.status === "DONE" || task?.status === "CANCELLED";
  const footer =
    task && !closed ? (
      <div className="dispatch-bar">
        {pending.length > 0 ? (
          <div className="dispatch-pending">
            {pending.map((command) => (
              <CommandCard key={command.doc.id} command={command} compact />
            ))}
          </div>
        ) : blocker ? (
          <p className="dispatch-reason" data-tone={dispatchEnabled ? undefined : "user"}>
            {dispatchEnabled ? null : <WarningCircle size={16} weight="bold" aria-hidden="true" />}
            {blocker}
          </p>
        ) : retry ? (
          <p className="dispatch-reason">
            {retryHasReason
              ? "上次没有跑成功；把上面的原因处理好后，可以再交给 Claude。"
              : "上次没有跑成功，可以再交给 Claude 试一次；详细原因在电脑 ATM 的派单记录里。"}
          </p>
        ) : (
          <p className="dispatch-reason">
            电脑收到后会拉起 Claude Code 领取这个任务、补全目标并开工。
          </p>
        )}
        <button
          type="button"
          className="button primary block"
          disabled={Boolean(blocker) || waitingForAck || sending}
          onClick={() => void send()}
        >
          <Sparkle size={18} weight="fill" aria-hidden="true" />
          {waitingForAck ? "等待电脑接收…" : retry && !blocker ? "再次交给 Claude" : "交给 Claude"}
        </button>
      </div>
    ) : undefined;

  return (
    <Screen
      className="task-screen"
      title={<span className="mono topbar-key">{taskKey}</span>}
      footer={footer}
    >
      <OfflineNote />
      {!task ? (
        <EmptyState icon={<MagnifyingGlass size={26} weight="duotone" />} title="找不到这个任务">
          它可能已经关闭超过 14 天，或被移到了别的项目。
        </EmptyState>
      ) : (
        <TaskBody task={task} now={now} />
      )}
    </Screen>
  );
}

function TaskBody({ task, now }: { task: TaskCard; now: number }) {
  const closed = task.status === "DONE" || task.status === "CANCELLED";
  const flagged = task.priority === "HIGH" || task.priority === "CRITICAL";
  const failureReason = dispatchFailureReason(null, task);
  const note =
    task.status === "BLOCKED"
      ? task.blocked
      : task.status.startsWith("WAITING")
        ? task.waiting
        : null;
  return (
    <>
      <div className="task-hero">
        <h2 className="task-hero-title">{task.title}</h2>
        <div className="badge-row">
          <StatusBadge status={task.status} />
          {flagged ? (
            <span className="priority-flag" data-priority={task.priority}>
              {priorityLabel(task.priority)}优先级
            </span>
          ) : null}
          {/* 只有状态是胶囊：类型和普通优先级退成一行小字，不和状态徽章抢色。 */}
          <span className="badge-meta">
            {typeLabel(task.type)}
            {flagged ? "" : ` · ${priorityLabel(task.priority)}优先级`}
          </span>
        </div>
        <div className="task-hero-progress">
          <Progress value={task.progress} />
          <span className="task-percent">{Math.round(task.progress)}%</span>
        </div>
        <p className="task-hero-meta">
          {task.claim ? (
            <span className="task-hero-agent">
              <Robot size={15} weight="duotone" aria-hidden="true" />
              <span className="mono">{task.claim.agent}</span>
              {task.claim.since ? <span>{formatRelative(task.claim.since, now)}领取</span> : null}
            </span>
          ) : (
            <span>还没有人领取</span>
          )}
          <span className="task-hero-updated">
            <Clock size={14} weight="bold" aria-hidden="true" />
            更新于 {formatRelative(task.updatedAt, now)}
          </span>
        </p>
      </div>

      {note ? (
        <div className="callout" data-status={task.status} role="note">
          {task.status === "BLOCKED" ? (
            <Prohibit size={18} weight="bold" aria-hidden="true" />
          ) : (
            <Hourglass size={18} weight="bold" aria-hidden="true" />
          )}
          <span>
            <strong>
              {task.status === "BLOCKED"
                ? "受阻原因"
                : task.status === "WAITING_USER"
                  ? "需要你决定"
                  : "在等"}
            </strong>
            {note}
          </span>
        </div>
      ) : null}

      {task.dispatch ? (
        <section className="soft-section">
          <h3>Claude 派单</h3>
          <div className="dispatch-row">
            <ToneBadge tone={dispatchTone(task.dispatch.state)}>
              <span className="dispatch-dot" data-state={task.dispatch.state} aria-hidden="true" />
              {DISPATCH_LABELS[task.dispatch.state]}
            </ToneBadge>
            <span className="dispatch-time">{formatRelative(task.dispatch.at, now)}</span>
          </div>
          {failureReason ? (
            <p className="dispatch-reason dispatch-error" data-tone="blocked">
              <WarningCircle size={16} weight="bold" aria-hidden="true" />
              {failureReason}
            </p>
          ) : null}
        </section>
      ) : null}

      {closed ? (
        <p className="closed-note">已结束的任务只同步标题与状态；详情请在电脑上查看。</p>
      ) : (
        <>
          <Description text={task.desc} />
          {task.acceptance && task.acceptance.length > 0 ? (
            <section className="soft-section">
              <h3>验收标准</h3>
              <ol className="acceptance">
                {task.acceptance.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ol>
            </section>
          ) : null}
          {task.checklist && task.checklist.total > 0 ? (
            <section className="soft-section">
              <h3>
                清单
                <span className="soft-section-aside">
                  {task.checklist.done}/{task.checklist.total}
                </span>
              </h3>
              <Progress
                value={(task.checklist.done / task.checklist.total) * 100}
                label="清单进度"
              />
            </section>
          ) : null}
          {task.recent && task.recent.length > 0 ? (
            <section className="soft-section">
              <h3>最近进度</h3>
              <ol className="timeline">
                {task.recent.map((entry, index) => (
                  <li key={index}>
                    <span className="timeline-time">{formatClock(entry.at, now)}</span>
                    <span className="timeline-text">{entry.summary}</span>
                    {entry.percent !== undefined ? (
                      <span className="timeline-percent">{entry.percent}%</span>
                    ) : null}
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
        </>
      )}
    </>
  );
}

function Description({ text }: { text: string | undefined }) {
  const [expanded, setExpanded] = useState(false);
  const long = (text?.length ?? 0) > LONG_DESCRIPTION;
  return (
    <section className="soft-section">
      <h3>目标描述</h3>
      {text ? (
        <>
          <p className="description" data-clamped={long && !expanded ? "true" : "false"}>
            {text}
          </p>
          {long ? (
            <button type="button" className="text-button" onClick={() => setExpanded(!expanded)}>
              {expanded ? "收起" : "展开全文"}
            </button>
          ) : null}
        </>
      ) : (
        <p className="description is-empty">还没有写目标描述。交给 Claude 后它会先把目标补全。</p>
      )}
    </section>
  );
}

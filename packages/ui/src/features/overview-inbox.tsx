import type { ComponentType } from "react";
import { ChatCircleIcon as ChatCircle } from "@phosphor-icons/react/dist/icons/ChatCircle";
import { CheckIcon as Check } from "@phosphor-icons/react/dist/icons/Check";
import { PauseIcon as Pause } from "@phosphor-icons/react/dist/icons/Pause";
import type { AyanamiClient } from "@ayanami-task/client";
import { Empty, LoadingRows } from "../components/async-state.js";
import { useCursorCollections } from "../cursor-collection.js";
import { formatTime } from "../presentation.js";

/**
 * 「等你处理」：跨项目列出卡在人这边的任务——受阻、等你回复、待验收。
 * 颜色只在左侧图标块和类别字上出现，行本身保持中性。
 */
const KINDS = {
  BLOCKED: { label: "受阻", Icon: Pause, order: 0 },
  WAITING_USER: { label: "等你回复", Icon: ChatCircle, order: 1 },
  VERIFYING: { label: "待验收", Icon: Check, order: 2 },
} as const satisfies Record<string, { label: string; Icon: ComponentType<any>; order: number }>;

type Kind = keyof typeof KINDS;

export type NeedsYouTask = {
  project: string;
  key: string;
  title: string;
  status: Kind;
  reason: string;
  updatedAt: string | null;
};

export function needsYouTasks(entries: Array<{ key: string; items: any[] }>): NeedsYouTask[] {
  return entries
    .flatMap((entry) =>
      entry.items
        .filter((task) => task.status in KINDS)
        .map((task) => ({
          project: entry.key,
          key: String(task.key),
          title: String(task.title),
          status: task.status as Kind,
          reason: String(task.blockedReason || task.waitingFor || ""),
          updatedAt: (task.updatedAt ?? task.updated_at ?? null) as string | null,
        })),
    )
    .sort(
      (left, right) =>
        KINDS[left.status].order - KINDS[right.status].order ||
        String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")),
    );
}

export function NeedsYouList({
  tasks,
  onTask,
}: {
  tasks: NeedsYouTask[];
  onTask: (project: string, key: string) => void;
}) {
  if (!tasks.length)
    return <Empty title="没有等你处理的事" text="受阻、等你回复和待验收的任务会出现在这里。" />;
  return (
    <div className="atm-list atm-inbox">
      {tasks.map((task) => {
        const { label, Icon } = KINDS[task.status];
        return (
          <button
            type="button"
            className="atm-row atm-inbox-row"
            data-kind={task.status}
            key={`${task.project}:${task.key}`}
            onClick={() => onTask(task.project, task.key)}
          >
            <span className="atm-inbox-icon" aria-hidden="true">
              <Icon size={16} weight="bold" />
            </span>
            <span className="atm-inbox-main">
              <span className="atm-inbox-meta">
                <b>{label}</b>
                <span className="atm-key">{task.key}</span>
              </span>
              <span className="atm-row-title">{task.title}</span>
              {task.reason ? <span className="atm-row-sub">{task.reason}</span> : null}
            </span>
            <time className="atm-inbox-time">{formatTime(task.updatedAt)}</time>
          </button>
        );
      })}
    </div>
  );
}

export function NeedsYouPanel({
  client,
  projects,
  onTask,
}: {
  client: AyanamiClient;
  /** 只用到代号和生命周期：总览的项目摘要和注册表里的项目都能直接传进来。 */
  projects: Array<{ code: string; lifecycle?: string | null }>;
  onTask: (project: string, key: string) => void;
}) {
  const sources = projects
    .filter((project) => project.lifecycle === "ACTIVE")
    .map((project) => ({
      key: project.code,
      loadPage: (cursor?: string) =>
        client.tasks.pageForUi(project.code, {
          closed: "0",
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        }),
    }));
  const collection = useCursorCollections(
    ["tasks", "all", "ui", "open", ...sources.map((source) => source.key)],
    sources,
  );
  const entries = Object.values(collection.entries);
  const loading = entries.length === 0 || entries.some((entry) => entry.isLoading);
  const tasks = needsYouTasks(entries);
  return (
    <section className="atm-panel" aria-labelledby="atm-needs-you-title">
      <div className="atm-panel-head">
        <h2 id="atm-needs-you-title">等你处理</h2>
        {tasks.length ? <span className="atm-badge warning">{tasks.length}</span> : null}
      </div>
      {loading && tasks.length === 0 && sources.length ? (
        <LoadingRows count={3} />
      ) : (
        <NeedsYouList tasks={tasks} onTask={onTask} />
      )}
    </section>
  );
}

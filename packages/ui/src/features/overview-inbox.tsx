import type { ComponentType } from "react";
import { ChatCircleIcon as ChatCircle } from "@phosphor-icons/react/dist/icons/ChatCircle";
import { CheckIcon as Check } from "@phosphor-icons/react/dist/icons/Check";
import { PauseIcon as Pause } from "@phosphor-icons/react/dist/icons/Pause";
import type { AyanamiClient } from "@ayanami-task/client";
import { CursorLoadStatus, Empty, LoadingRows } from "../components/async-state.js";
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

/** 「等你处理」的统计范围：活动的正式项目里，受阻、等你回复、待验收三类未结束任务。 */
export type NeedsYouState = {
  tasks: NeedsYouTask[];
  /** 全部项目都读完、没有失败也没有剩页：只有这时「一共几件」「没有」才算数。 */
  complete: boolean;
  loading: boolean;
  error: unknown;
  hasMore: boolean;
  entries: Array<{ key: string; error: unknown }>;
  retry: (key: string) => void;
};

type NeedsYouEntry = {
  key: string;
  items: any[];
  isLoading: boolean;
  isFetchingNextPage: boolean;
  hasMore: boolean;
  error: unknown;
};

/** 纯函数：从各项目的读取状态推出「等你处理」的结论，页头和面板都用它。 */
export function needsYouState(
  sourceKeys: string[],
  entries: NeedsYouEntry[],
  retry: (key: string) => void,
): NeedsYouState {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const settled = sourceKeys.map((key) => byKey.get(key));
  const loading = settled.some((entry) => !entry || entry.isLoading || entry.isFetchingNextPage);
  const failed = entries.find((entry) => entry.error);
  const hasMore = entries.some((entry) => entry.hasMore);
  return {
    tasks: needsYouTasks(entries),
    complete: !loading && !failed && !hasMore,
    loading,
    error: failed?.error ?? null,
    hasMore,
    entries: entries.map((entry) => ({ key: entry.key, error: entry.error })),
    retry,
  };
}

export function useNeedsYou(
  client: AyanamiClient,
  projects: Array<{ code: string; lifecycle?: string | null }>,
): NeedsYouState {
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
  return needsYouState(
    sources.map((source) => source.key),
    Object.values(collection.entries),
    (key) => void collection.retry(key),
  );
}

/** 页头结论只在读完时给数字；没读完或读失败时照实说，不提前下「没有」的结论。 */
export function needsYouHeadline(state: NeedsYouState, active: number): string {
  if (state.error) return "等你处理的事没能全部读出来，可在下方重试。";
  if (!state.complete) return "正在汇总等你处理的事…";
  const rest = active ? `${active} 个任务正在推进。` : "眼下没有进行中的任务。";
  return state.tasks.length
    ? `${state.tasks.length} 件事等你处理，${rest}`
    : `没有要你处理的事，${rest}`;
}

export function NeedsYouPanel({
  state,
  onTask,
}: {
  state: NeedsYouState;
  onTask: (project: string, key: string) => void;
}) {
  const { tasks } = state;
  return (
    <section className="atm-panel" aria-labelledby="atm-needs-you-title">
      <div className="atm-panel-head">
        <h2 id="atm-needs-you-title">等你处理</h2>
        {tasks.length ? <span className="atm-badge warning">{tasks.length}</span> : null}
      </div>
      {!state.complete ? (
        <div className="atm-panel-body atm-needs-you-status">
          <CursorLoadStatus
            loadedCount={tasks.length}
            matchedCount={tasks.length}
            hasMore={state.hasMore}
            loading={state.loading}
            error={state.error}
            onRetry={() => {
              for (const entry of state.entries) if (entry.error) state.retry(entry.key);
            }}
          />
        </div>
      ) : null}
      {tasks.length ? (
        <NeedsYouList tasks={tasks} onTask={onTask} />
      ) : state.complete ? (
        <NeedsYouList tasks={[]} onTask={onTask} />
      ) : state.loading && !state.error ? (
        <LoadingRows count={3} />
      ) : null}
    </section>
  );
}

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AyanamiClient } from "@ayanami-task/client";
import { Empty, ErrorState, LoadingRows, PageHead } from "../components/async-state.js";
import { formatTime } from "../presentation.js";
import {
  isSystemTimelineEvent,
  presentTimelineEvent,
  timelineActorLabel,
  visibleSubjectKey,
} from "../timeline-events.js";

/**
 * 一条事件两行：正文一句话说清发生了什么，下面一行是项目、业务键、谁、什么时候。
 *
 * 以前一条占四行，同一件事说三遍——「创建任务」「创建任务 X-T-1「…」」「任务已创建」，
 * 还带着对人没有意义的「序列 N」和 ULID。
 */
export function TimelineEventRow({ event }: { event: Record<string, unknown> }) {
  const item = presentTimelineEvent(event);
  const project = item.projectName ?? item.projectCode;
  const subjectKey = visibleSubjectKey(item);
  const actor = timelineActorLabel(item.actor);
  return (
    <article
      className="atm-event"
      data-event-type={item.type}
      data-sequence={item.sequence ?? undefined}
    >
      <div className="atm-row-title atm-event-summary">{item.detail ?? item.title}</div>
      <div className="atm-row-sub atm-event-meta">
        {project ? <span>{project}</span> : null}
        {subjectKey ? <strong>{subjectKey}</strong> : null}
        {actor ? <span>{actor}</span> : null}
        {item.occurredAt ? (
          <time dateTime={item.occurredAt}>{formatTime(item.occurredAt)}</time>
        ) : null}
      </div>
    </article>
  );
}

export function SystemEventsToggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="atm-filter atm-filter-check">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      显示系统事件
    </label>
  );
}

/** 默认隐藏系统事件；勾选后原样显示全部。 */
export function useTimelineEvents(events: Record<string, unknown>[]) {
  const [showSystem, setShowSystem] = useState(false);
  const visible = showSystem ? events : events.filter((event) => !isSystemTimelineEvent(event));
  return { showSystem, setShowSystem, visible, hiddenCount: events.length - visible.length };
}

export function GlobalTimelinePage({ client }: { client: AyanamiClient }) {
  const query = useQuery({ queryKey: ["overview"], queryFn: () => client.overview() });
  const timeline = useTimelineEvents((query.data?.recentEvents ?? []) as Record<string, unknown>[]);
  return (
    <>
      <PageHead
        title="全局时间线"
        description="跨项目的最近状态变化。自动备份等系统事件默认隐藏。"
        actions={
          <SystemEventsToggle checked={timeline.showSystem} onChange={timeline.setShowSystem} />
        }
      />
      <section className="atm-panel">
        {query.isLoading ? (
          <LoadingRows />
        ) : query.error ? (
          <ErrorState error={query.error} />
        ) : !timeline.visible.length ? (
          <Empty
            title="没有全局事件"
            text={
              timeline.hiddenCount
                ? `最近只有 ${timeline.hiddenCount} 条系统事件，勾选「显示系统事件」查看。`
                : "项目或临时任务产生变化后会显示在这里。"
            }
          />
        ) : (
          <div className="atm-timeline">
            {timeline.visible.map((event) => {
              const item = presentTimelineEvent(event);
              return <TimelineEventRow event={event} key={item.id} />;
            })}
          </div>
        )}
      </section>
    </>
  );
}

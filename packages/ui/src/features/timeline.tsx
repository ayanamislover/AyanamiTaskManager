import { useQuery } from "@tanstack/react-query";
import type { AyanamiClient } from "@ayanami-task/client";
import { Empty, ErrorState, LoadingRows, PageHead } from "../components/async-state.js";
import { formatTime } from "../presentation.js";
import { presentTimelineEvent } from "../timeline-events.js";

export function TimelineEventRow({ event }: { event: Record<string, unknown> }) {
  const item = presentTimelineEvent(event);
  const project = item.projectName ?? item.projectCode;
  return (
    <article className="atm-event" data-event-type={item.type}>
      {project || item.subjectKey ? (
        <div className="atm-event-context">
          {project ? <span>{project}</span> : null}
          {item.subjectKey ? <strong>{item.subjectKey}</strong> : null}
        </div>
      ) : null}
      <div className="atm-row-title">{item.title}</div>
      {item.detail && item.detail !== item.title ? (
        <p className="atm-event-detail">{item.detail}</p>
      ) : null}
      <div className="atm-row-sub atm-event-meta">
        <span>{item.category}</span>
        {item.actor ? <span>{item.actor}</span> : null}
        {item.sequence === null ? null : <span>序列 {item.sequence}</span>}
        {item.occurredAt ? (
          <time dateTime={item.occurredAt}>{formatTime(item.occurredAt)}</time>
        ) : null}
      </div>
    </article>
  );
}

export function GlobalTimelinePage({ client }: { client: AyanamiClient }) {
  const query = useQuery({ queryKey: ["overview"], queryFn: () => client.overview() });
  return (
    <>
      <PageHead
        title="全局时间线"
        description="跨项目的投影事件，用于快速定位最近发生的状态变化。"
      />
      <section className="atm-panel">
        {query.isLoading ? (
          <LoadingRows />
        ) : query.error ? (
          <ErrorState error={query.error} />
        ) : !(query.data!.recentEvents ?? []).length ? (
          <Empty title="没有全局事件" text="项目或临时任务产生变化后会显示在这里。" />
        ) : (
          <div className="atm-timeline">
            {(query.data!.recentEvents as Record<string, unknown>[]).map((event) => {
              const item = presentTimelineEvent(event);
              return <TimelineEventRow event={event} key={item.id} />;
            })}
          </div>
        )}
      </section>
    </>
  );
}

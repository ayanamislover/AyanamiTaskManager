type DeltaEvent = {
  seq: number;
  type: string;
  key: string | null;
  summary: string | null;
  actor: string;
  title: string;
  detail: string;
  changes?: Record<string, unknown>;
  op_id: string | null;
  at: string;
};

export function fitDelta(
  project: string,
  sinceSeq: number,
  requestedLimit: number,
  maxChars: number,
  payload: Record<string, any>,
): Record<string, unknown> {
  const events = (Array.isArray(payload.events) ? payload.events : []).map(
    (event: Record<string, any>): DeltaEvent => ({
      seq: Number(event.seq),
      type: String(event.type ?? ""),
      key: event.key === null || event.key === undefined ? null : String(event.key),
      summary: event.summary === null || event.summary === undefined ? null : String(event.summary),
      actor: String(event.actor ?? ""),
      title: String(event.title ?? ""),
      detail: String(event.detail ?? ""),
      ...(event.changes && typeof event.changes === "object" ? { changes: event.changes } : {}),
      op_id: event.opId === null || event.opId === undefined ? null : String(event.opId),
      at: String(event.at ?? ""),
    }),
  );
  const currentSequence = Number(payload.currentSequence ?? sinceSeq);
  const serviceHasMore = payload.hasMore === true;
  const projectInfo =
    payload.events?.[0]?.project && typeof payload.events[0].project === "object"
      ? {
          code: String(payload.events[0].project.code ?? project).toUpperCase(),
          name: String(payload.events[0].project.name ?? ""),
        }
      : { code: project.toUpperCase() };

  for (let count = events.length; count >= 0; count -= 1) {
    const returned = events.slice(0, count);
    const nextSeq = returned.at(-1)?.seq ?? sinceSeq;
    const budgetTruncated = count < events.length;
    const hasMore = budgetTruncated || serviceHasMore;
    const candidate: Record<string, unknown> = {
      project: projectInfo,
      since_seq: sinceSeq,
      requested_limit: requestedLimit,
      returned_count: returned.length,
      events: returned,
      current_sequence: currentSequence,
      next_seq: nextSeq,
      has_more: hasMore,
      truncated: budgetTruncated,
      ...(budgetTruncated
        ? {
            truncated_collections: [
              {
                path: "events",
                original_items: events.length,
                returned_items: returned.length,
              },
            ],
          }
        : {}),
      ...(hasMore
        ? {
            continuation: {
              tool: "atm_delta",
              arguments: {
                project: project.toUpperCase(),
                since_seq: nextSeq,
                limit: requestedLimit,
                max_chars: maxChars,
              },
            },
          }
        : {}),
    };
    if (count === 0 && events.length > 0) {
      const firstEvent = events[0]!;
      const firstEventChars = JSON.stringify(firstEvent).length;
      const restPath = `/api/v1/projects/${project.toUpperCase()}/events?since=${Math.max(0, firstEvent.seq - 1)}&limit=1`;
      candidate.next_seq = firstEvent.seq;
      const hasFollowingEvents = events.length > 1 || serviceHasMore;
      candidate.has_more = hasFollowingEvents;
      candidate.oversized_event = {
        seq: firstEvent.seq,
        type: firstEvent.type,
        key: firstEvent.key,
        op_id: firstEvent.op_id,
        chars: firstEventChars,
        continuation: {
          transport: "REST",
          method: "GET",
          authentication: "daemon_bearer",
          path: restPath,
        },
      };
      const continuation = candidate.continuation as Record<string, any> | undefined;
      if (continuation && hasFollowingEvents) {
        continuation.arguments.since_seq = firstEvent.seq;
      } else if (!hasFollowingEvents) {
        delete candidate.continuation;
      }
    }
    if (JSON.stringify(candidate).length <= maxChars) return candidate;
  }

  const firstEvent = events[0];
  return {
    project: projectInfo,
    since_seq: sinceSeq,
    requested_limit: requestedLimit,
    returned_count: 0,
    events: [],
    current_sequence: currentSequence,
    next_seq: firstEvent?.seq ?? sinceSeq,
    has_more: firstEvent === undefined ? serviceHasMore : events.length > 1 || serviceHasMore,
    truncated: events.length > 0,
    ...(firstEvent === undefined
      ? {}
      : {
          oversized_event: {
            seq: firstEvent.seq,
            continuation: {
              transport: "REST",
              method: "GET",
              authentication: "daemon_bearer",
              path: `/api/v1/projects/${project.toUpperCase()}/events?since=${Math.max(0, firstEvent.seq - 1)}&limit=1`,
            },
          },
        }),
  };
}

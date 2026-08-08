export type AgentSessionLike = {
  id: string;
  agent_id: string;
  project: string;
  connection_state: string;
  last_seen_at?: string | null;
};

export type AgentSessionSummary<T extends AgentSessionLike> = T & { sessionCount: number };

function activityTime(session: AgentSessionLike): number {
  const parsed = Date.parse(session.last_seen_at ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function shouldPrefer<T extends AgentSessionLike>(candidate: T, current: T): boolean {
  const candidateOnline = candidate.connection_state === "ONLINE";
  const currentOnline = current.connection_state === "ONLINE";
  if (candidateOnline !== currentOnline) return candidateOnline;
  return activityTime(candidate) > activityTime(current);
}

export function summarizeAgentSessions<T extends AgentSessionLike>(
  sessions: T[],
): Array<AgentSessionSummary<T>> {
  const groups = new Map<string, { selected: T; count: number }>();
  for (const session of sessions) {
    const key = `${session.project}\u0000${session.agent_id}`;
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { selected: session, count: 1 });
      continue;
    }
    group.count += 1;
    if (shouldPrefer(session, group.selected)) group.selected = session;
  }

  return [...groups.values()]
    .map(({ selected, count }) => ({ ...selected, sessionCount: count }))
    .sort((left, right) => {
      const online =
        Number(right.connection_state === "ONLINE") - Number(left.connection_state === "ONLINE");
      if (online) return online;
      const activity = activityTime(right) - activityTime(left);
      if (activity) return activity;
      return `${left.project}:${left.agent_id}`.localeCompare(`${right.project}:${right.agent_id}`);
    });
}

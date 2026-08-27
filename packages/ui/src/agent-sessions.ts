import type { SessionView } from "@ayanami-task/protocol";

export type AgentSessionLike = {
  id: string;
  agentId: string;
  project: string;
  displayName?: string | null;
  clientKind?: string | null;
  capabilities?: unknown[];
  parentSessionId?: string | null;
  predecessorSessionId?: string | null;
  threadId?: string | null;
  role?: string | null;
  connectionState: string;
  lastSeenAt?: string | null;
  startedAt?: string | null;
  closedAt?: string | null;
  currentTaskKey?: string | null;
  workState?: string | null;
  cwd?: string | null;
  git?: Partial<SessionView["git"]> | null;
};

export type AgentSessionConflict = {
  kind: "SAME_WORKTREE" | "SAME_BRANCH";
  value: string;
  count: number;
  sessionIds: string[];
};

function duplicateContexts(
  sessions: AgentSessionLike[],
  kind: AgentSessionConflict["kind"],
  select: (session: AgentSessionLike) => string | null | undefined,
): AgentSessionConflict[] {
  const groups = new Map<string, { value: string; ids: string[] }>();
  for (const session of sessions.filter((item) => item.connectionState === "ONLINE")) {
    const value = select(session)?.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    const group = groups.get(key) ?? { value, ids: [] };
    group.ids.push(session.id);
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => group.ids.length > 1)
    .map((group) => ({
      kind,
      value: group.value,
      count: group.ids.length,
      sessionIds: group.ids,
    }));
}

export function findAgentSessionConflicts(sessions: AgentSessionLike[]): AgentSessionConflict[] {
  return [
    ...duplicateContexts(sessions, "SAME_WORKTREE", (session) => session.git?.worktreeRoot),
    ...duplicateContexts(sessions, "SAME_BRANCH", (session) => session.git?.branch),
  ];
}

export type AgentSessionSummary<T extends AgentSessionLike> = T & {
  sessionCount: number;
  /** Complete audit history for this project/Agent identity, newest first. */
  sessionHistory: T[];
};

export type AgentProjectGroup<T extends AgentSessionLike> = {
  project: string;
  agents: Array<AgentSessionSummary<T>>;
  sessionCount: number;
  onlineCount: number;
  lastSeenAt: string | null;
};

function activityTime(session: AgentSessionLike): number {
  const parsed = Date.parse(session.lastSeenAt ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function shouldPrefer<T extends AgentSessionLike>(candidate: T, current: T): boolean {
  const candidateOnline = candidate.connectionState === "ONLINE";
  const currentOnline = current.connectionState === "ONLINE";
  if (candidateOnline !== currentOnline) return candidateOnline;
  return activityTime(candidate) > activityTime(current);
}

export function summarizeAgentSessions<T extends AgentSessionLike>(
  sessions: T[],
): Array<AgentSessionSummary<T>> {
  const groups = new Map<string, { selected: T; sessions: T[] }>();
  for (const session of sessions) {
    const key = `${session.project}\u0000${session.agentId}`;
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { selected: session, sessions: [session] });
      continue;
    }
    group.sessions.push(session);
    if (shouldPrefer(session, group.selected)) group.selected = session;
  }

  return [...groups.values()]
    .map(({ selected, sessions: history }) => ({
      ...selected,
      sessionCount: history.length,
      sessionHistory: [...history].sort((left, right) => activityTime(right) - activityTime(left)),
    }))
    .sort((left, right) => {
      const online =
        Number(right.connectionState === "ONLINE") - Number(left.connectionState === "ONLINE");
      if (online) return online;
      const activity = activityTime(right) - activityTime(left);
      if (activity) return activity;
      return `${left.project}:${left.agentId}`.localeCompare(`${right.project}:${right.agentId}`);
    });
}

/**
 * Shape Agent sessions for the UI's primary information architecture.
 *
 * The API returns a flat list because it is also used for conflict detection.
 * Keep that list intact for the audit details, but expose a stable project-level
 * grouping so the page never mixes sessions from unrelated projects.
 */
export function groupAgentSessions<T extends AgentSessionLike>(
  sessions: T[],
): Array<AgentProjectGroup<T>> {
  const groups = new Map<string, AgentSessionSummary<T>[]>();
  for (const agent of summarizeAgentSessions(sessions)) {
    const group = groups.get(agent.project) ?? [];
    group.push(agent);
    groups.set(agent.project, group);
  }

  return [...groups.entries()]
    .map(([project, agents]) => {
      const histories = agents.flatMap((agent) => agent.sessionHistory);
      const onlineCount = histories.filter(
        (session) => session.connectionState === "ONLINE",
      ).length;
      const latest = histories.reduce<string | null>((current, session) => {
        if (!session.lastSeenAt) return current;
        const currentTime = current ? Date.parse(current) : 0;
        if (!current || activityTime(session) > (Number.isFinite(currentTime) ? currentTime : 0)) {
          return session.lastSeenAt;
        }
        return current;
      }, null);
      return {
        project,
        agents,
        sessionCount: histories.length,
        onlineCount,
        lastSeenAt: latest,
      };
    })
    .sort((left, right) => {
      if (left.onlineCount !== right.onlineCount) return right.onlineCount - left.onlineCount;
      const activity = Date.parse(right.lastSeenAt ?? "") - Date.parse(left.lastSeenAt ?? "");
      if (Number.isFinite(activity) && activity !== 0) return activity;
      return left.project.localeCompare(right.project);
    });
}

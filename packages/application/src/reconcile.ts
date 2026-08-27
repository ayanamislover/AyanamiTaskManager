import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export type ReconciliationClassification =
  | "ACTIVE"
  | "LEASE_EXPIRED_ONLINE"
  | "STALLED"
  | "POSSIBLY_COMPLETE";

export type ReconciliationTask = {
  id: string;
  key: string;
  title: string;
  status: string;
  acceptance: string[];
  claimedBySessionId: string | null;
  claimLeaseUntil: string | null;
  updatedAt: string;
};

export type ReconciliationSession = {
  id: string;
  agent_id: string;
  display_name?: string | null;
  connection_state: string;
  last_seen_at?: string | null;
  ended_at?: string | null;
};

export type ReconciliationItem = {
  taskKey: string;
  title: string;
  status: string;
  classification: ReconciliationClassification;
  reason: string;
  ageSeconds: number;
  session: {
    id: string;
    agentId: string;
    displayName: string;
    connectionState: string;
    lastSeenAt: string | null;
    endedAt: string | null;
  } | null;
  suggestedAction: string;
  evidencePaths: string[];
};

const COUNTS: Record<ReconciliationClassification, number> = {
  ACTIVE: 0,
  LEASE_EXPIRED_ONLINE: 0,
  STALLED: 0,
  POSSIBLY_COMPLETE: 0,
};

const TERMINAL_STATES = new Set(["DONE", "CANCELLED"]);
const POSSIBLY_COMPLETE_STATES = new Set(["BACKLOG", "READY"]);

function secondsSince(now: Date, at: string | null | undefined): number {
  const timestamp = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(timestamp)
    ? Math.max(0, Math.floor((now.getTime() - timestamp) / 1000))
    : 0;
}

function presentSession(session: ReconciliationSession | undefined): ReconciliationItem["session"] {
  if (!session) return null;
  return {
    id: session.id,
    agentId: session.agent_id,
    displayName: session.display_name || session.agent_id,
    connectionState: session.connection_state,
    lastSeenAt: session.last_seen_at ?? null,
    endedAt: session.ended_at ?? null,
  };
}

function looksLikeRelativePath(value: string, allowBareFile: boolean): boolean {
  const candidate = value.trim().replace(/^['"]|['"]$/gu, "");
  if (!candidate || candidate.includes(":")) return false;
  if (isAbsolute(candidate)) return false;
  return (
    candidate.startsWith("./") ||
    candidate.startsWith(".\\") ||
    candidate.startsWith("../") ||
    candidate.startsWith("..\\") ||
    candidate.includes("/") ||
    candidate.includes("\\") ||
    (allowBareFile && /[A-Za-z0-9_@() -]+\.[A-Za-z0-9_-]{1,16}$/u.test(candidate))
  );
}

/**
 * Extract only path-shaped acceptance fragments. Natural-language statements without an
 * explicit relative path are deliberately ignored: reconciliation may suggest, never infer.
 */
export function explicitAcceptancePaths(acceptance: string[]): string[] {
  const result = new Set<string>();
  for (const statement of acceptance) {
    for (const match of statement.matchAll(/`([^`\r\n]+)`/gu)) {
      const candidate = match[1]!.trim();
      if (looksLikeRelativePath(candidate, true)) result.add(candidate);
    }
    const withoutCode = statement.replace(/`[^`\r\n]+`/gu, " ");
    // Choice (b): prose needs a path separator; backticks may still identify a root-level file.
    // Skipping nonexistent matches (choice a) would weaken the all-explicit-paths contract and
    // could suggest completion while a real, explicitly named artifact is still missing.
    const candidates = withoutCode.match(
      /(?:\.{1,2}[\\/])?(?:(?:[A-Za-z0-9_@()-]+)[\\/])+(?:[A-Za-z0-9_@().-]+)/gu,
    );
    for (const candidate of candidates ?? []) {
      if (looksLikeRelativePath(candidate, false)) result.add(candidate);
    }
  }
  return [...result];
}

function isContained(root: string, candidate: string): boolean {
  const offset = relative(root, candidate);
  return (
    offset === "" ||
    (!offset.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      offset !== ".." &&
      !isAbsolute(offset))
  );
}

function verifiedAcceptancePaths(sourceRoot: string | null, acceptance: string[]): string[] | null {
  if (!sourceRoot) return null;
  const explicit = explicitAcceptancePaths(acceptance);
  if (explicit.length === 0) return null;
  try {
    const canonicalRoot = realpathSync.native(sourceRoot);
    for (const path of explicit) {
      const lexical = resolve(canonicalRoot, path);
      if (!isContained(canonicalRoot, lexical)) return null;
      const canonicalPath = realpathSync.native(lexical);
      if (!isContained(canonicalRoot, canonicalPath)) return null;
    }
    return explicit;
  } catch {
    return null;
  }
}

export function reconcileWorkItems(input: {
  now?: Date;
  sourceRoot: string | null;
  tasks: ReconciliationTask[];
  sessions: ReconciliationSession[];
  previouslyClaimedKeys: ReadonlySet<string>;
  includeActive?: boolean;
}): {
  generatedAt: string;
  attentionCount: number;
  counts: Record<ReconciliationClassification, number>;
  items: ReconciliationItem[];
} {
  const now = input.now ?? new Date();
  const sessions = new Map(input.sessions.map((session) => [session.id, session]));
  const allItems = input.tasks.map((task): ReconciliationItem => {
    const session = task.claimedBySessionId ? sessions.get(task.claimedBySessionId) : undefined;
    const leaseExpired =
      !TERMINAL_STATES.has(task.status) &&
      Boolean(task.claimedBySessionId) &&
      Boolean(task.claimLeaseUntil) &&
      Date.parse(task.claimLeaseUntil!) <= now.getTime();

    if (leaseExpired && session?.connection_state === "ONLINE") {
      return {
        taskKey: task.key,
        title: task.title,
        status: task.status,
        classification: "LEASE_EXPIRED_ONLINE",
        reason: "claim_lease_expired_but_session_online",
        ageSeconds: secondsSince(now, task.claimLeaseUntil),
        session: presentSession(session),
        suggestedAction: "先确认 Agent 是否仍在工作；需要接管时再显式释放或接管领取。",
        evidencePaths: [],
      };
    }
    if (leaseExpired && (!session || session.connection_state === "CLOSED")) {
      return {
        taskKey: task.key,
        title: task.title,
        status: task.status,
        classification: "STALLED",
        reason: session
          ? "session_closed_and_lease_expired"
          : "claim_session_missing_and_lease_expired",
        ageSeconds: secondsSince(now, task.claimLeaseUntil),
        session: presentSession(session),
        suggestedAction: "检查最后进度与证据后，由用户显式释放或由新 Session 接管。",
        evidencePaths: [],
      };
    }
    if (
      POSSIBLY_COMPLETE_STATES.has(task.status) &&
      !task.claimedBySessionId &&
      !input.previouslyClaimedKeys.has(task.key)
    ) {
      const evidencePaths = verifiedAcceptancePaths(input.sourceRoot, task.acceptance);
      if (evidencePaths) {
        return {
          taskKey: task.key,
          title: task.title,
          status: task.status,
          classification: "POSSIBLY_COMPLETE",
          reason: "all_explicit_acceptance_paths_exist_and_never_claimed",
          ageSeconds: secondsSince(now, task.updatedAt),
          session: null,
          suggestedAction: "人工核对产物内容与验收条件；确认无误后再正常领取、验收并完成。",
          evidencePaths,
        };
      }
    }
    return {
      taskKey: task.key,
      title: task.title,
      status: task.status,
      classification: "ACTIVE",
      reason: "no_reconciliation_attention_required",
      ageSeconds: secondsSince(now, task.updatedAt),
      session: presentSession(session),
      suggestedAction: "无需对账，按当前任务状态继续。",
      evidencePaths: [],
    };
  });
  const counts = { ...COUNTS };
  for (const item of allItems) counts[item.classification] += 1;
  const attentionCount = allItems.length - counts.ACTIVE;
  return {
    generatedAt: now.toISOString(),
    attentionCount,
    counts,
    items: input.includeActive
      ? allItems
      : allItems.filter((item) => item.classification !== "ACTIVE"),
  };
}

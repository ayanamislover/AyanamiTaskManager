import { AtmError } from "@ayanami-task/errors";

export type TaskRoutingSignals = {
  multiAgent?: boolean;
  multiSession?: boolean;
  subtaskCount?: number;
  hasDependencies?: boolean;
  expectedMinutes?: number;
  needsEvidence?: boolean;
  hasTargetDate?: boolean;
};

export type TaskScopeClassification = {
  scope: "quick" | "project";
  score: number;
  reason: "explicit" | "matched_project" | "automatic_score" | "short_one_off";
};

export function scoreTaskScope(signals: TaskRoutingSignals): number {
  return (
    (signals.multiAgent ? 3 : 0) +
    (signals.multiSession ? 2 : 0) +
    ((signals.subtaskCount ?? 0) >= 4 ? 2 : 0) +
    (signals.hasDependencies ? 2 : 0) +
    ((signals.expectedMinutes ?? 0) >= 45 ? 1 : 0) +
    (signals.needsEvidence ? 1 : 0) +
    (signals.hasTargetDate ? 1 : 0)
  );
}

export function classifyTaskScope(input: {
  matchedProject: boolean;
  explicitMode: "auto" | "quick" | "project";
  signals: TaskRoutingSignals;
}): TaskScopeClassification {
  const score = scoreTaskScope(input.signals);
  if (input.explicitMode !== "auto") {
    return { scope: input.explicitMode, score, reason: "explicit" };
  }
  if (input.matchedProject) return { scope: "project", score, reason: "matched_project" };
  if ((input.signals.expectedMinutes ?? 0) <= 15 && score === 0) {
    return { scope: "quick", score, reason: "short_one_off" };
  }
  return { scope: score >= 3 ? "project" : "quick", score, reason: "automatic_score" };
}

export type ProgressResult = {
  value: number;
  source: "CHILDREN" | "CHECKLIST" | "REPORTED" | "NONE";
};

function weightedRatio(items: Array<{ value: number; weight: number }>): number {
  const total = items.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
  if (total === 0) return 0;
  return items.reduce((sum, item) => sum + item.value * Math.max(0, item.weight), 0) / total;
}

export function computeProgress(input: {
  status: string;
  children: Array<{ progress: number; weight: number; cancelled: boolean }>;
  checklist: Array<{ done: boolean; weight: number }>;
  reported: number | null;
}): ProgressResult {
  if (input.status === "DONE") return { value: 100, source: "NONE" };
  const activeChildren = input.children.filter((child) => !child.cancelled);
  let result: ProgressResult;
  if (activeChildren.length > 0) {
    result = {
      value: weightedRatio(
        activeChildren.map((child) => ({ value: child.progress, weight: child.weight })),
      ),
      source: "CHILDREN",
    };
  } else if (input.checklist.length > 0) {
    result = {
      value: weightedRatio(
        input.checklist.map((item) => ({ value: item.done ? 100 : 0, weight: item.weight })),
      ),
      source: "CHECKLIST",
    };
  } else if (input.reported !== null) {
    result = {
      value: Math.round(Math.max(0, Math.min(100, input.reported)) / 10) * 10,
      source: "REPORTED",
    };
  } else {
    result = { value: 0, source: "NONE" };
  }
  result.value = Math.round(Math.min(99, result.value) * 10) / 10;
  return result;
}

export function assertAcyclicDependency(
  taskId: string,
  dependsOnId: string,
  dependencies: ReadonlyMap<string, readonly string[]>,
): void {
  if (taskId === dependsOnId)
    throw new AtmError("DEPENDENCY_CYCLE", {
      message: "WorkItem 不能依赖自身",
      details: { task_id: taskId, depends_on_id: dependsOnId, reason: "SELF_DEPENDENCY" },
    });
  const pending = [dependsOnId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === taskId)
      throw new AtmError("DEPENDENCY_CYCLE", {
        message: "依赖关系会形成环",
        details: { task_id: taskId, depends_on_id: dependsOnId, reason: "REACHES_TASK" },
      });
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(dependencies.get(current) ?? []));
  }
}

function parentDepth(itemId: string, parents: ReadonlyMap<string, string | null>): number {
  let depth = 1;
  let cursor = parents.get(itemId) ?? null;
  const visited = new Set([itemId]);
  while (cursor) {
    if (visited.has(cursor))
      throw new AtmError("HIERARCHY_CYCLE", {
        message: "现有 WorkItem 层级包含环",
        details: { item_id: itemId, parent_id: cursor, reason: "EXISTING_CYCLE" },
      });
    visited.add(cursor);
    depth += 1;
    cursor = parents.get(cursor) ?? null;
  }
  return depth;
}

function descendantDepth(itemId: string, parents: ReadonlyMap<string, string | null>): number {
  let maximum = 1;
  for (const candidate of parents.keys()) {
    let cursor: string | null = candidate;
    let depth = 1;
    const visited = new Set<string>();
    while (cursor && cursor !== itemId) {
      if (visited.has(cursor)) break;
      visited.add(cursor);
      cursor = parents.get(cursor) ?? null;
      depth += 1;
    }
    if (cursor === itemId) maximum = Math.max(maximum, depth);
  }
  return maximum;
}

export function assertParentMove(
  itemId: string,
  parentId: string | null,
  parents: ReadonlyMap<string, string | null>,
): void {
  if (parentId === itemId)
    throw new AtmError("HIERARCHY_CYCLE", {
      message: "WorkItem 不能作为自身父项",
      details: { item_id: itemId, parent_id: parentId, reason: "SELF_PARENT" },
    });
  let cursor = parentId;
  const visited = new Set<string>();
  while (cursor) {
    if (cursor === itemId)
      throw new AtmError("HIERARCHY_CYCLE", {
        message: "父项不能是当前 WorkItem 的后代",
        details: { item_id: itemId, parent_id: parentId, reason: "PARENT_IS_DESCENDANT" },
      });
    if (visited.has(cursor))
      throw new AtmError("HIERARCHY_CYCLE", {
        message: "现有 WorkItem 层级包含环",
        details: { item_id: itemId, parent_id: parentId, reason: "EXISTING_CYCLE" },
      });
    visited.add(cursor);
    cursor = parents.get(cursor) ?? null;
  }
  const prospectiveDepth =
    (parentId ? parentDepth(parentId, parents) : 0) + descendantDepth(itemId, parents);
  if (prospectiveDepth > 8)
    throw new AtmError("HIERARCHY_DEPTH", {
      message: "WorkItem 层级深度不能超过 8",
      details: {
        item_id: itemId,
        parent_id: parentId,
        max_depth: 8,
        prospective_depth: prospectiveDepth,
      },
    });
}

export function assertProjectCode(code: string): void {
  if (!/^[A-Z][A-Z0-9-]{1,11}$/u.test(code)) {
    throw new AtmError("INVALID_PROJECT_CODE", {
      message: `项目代码无效：${code}`,
      details: { code, pattern: "^[A-Z][A-Z0-9-]{1,11}$" },
    });
  }
}

function codeCandidate(name: string): string | null {
  const separated = name
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[^A-Za-z0-9]+/gu, " ")
    .trim();
  if (!separated) return null;
  const words = separated.split(/\s+/u).filter(Boolean);
  const first = words[0]!;
  const last = words.at(-1)!;
  const raw =
    words.length > 1 && last.length <= 4
      ? `${first[0]}${last}`
      : words.length > 1
        ? words.map((word) => word[0]).join("")
        : first.slice(0, 6);
  const candidate = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/gu, "")
    .slice(0, 12);
  return /^[A-Z][A-Z0-9]{1,11}$/u.test(candidate) ? candidate : null;
}

export function allocateProjectCode(
  name: string,
  existing: ReadonlySet<string>,
  fallbackNumber = 1,
): string {
  const base = codeCandidate(name) ?? `AYT-${String(fallbackNumber).padStart(4, "0")}`;
  assertProjectCode(base);
  if (!existing.has(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const suffixText = String(suffix);
    const candidate = `${base.slice(0, 12 - suffixText.length)}${suffixText}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new AtmError("PROJECT_CODE_EXHAUSTED", {
    message: `无法为项目分配唯一代码：${name}`,
    details: { name, base, attempts: 9_999 },
  });
}

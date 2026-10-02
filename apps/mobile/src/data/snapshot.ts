import type {
  DeviceDoc,
  HeadDoc,
  ProjectDoc,
  ProjectHead,
  TaskCard,
} from "@ayanami-task/sync-protocol";

/** 本机缓存的快照：电脑写的头部、各项目文档、电脑的在线状态，以及变更流游标。 */
export type Snapshot = {
  spaceId: string;
  /**
   * 缓存属于哪一个「中继 + 应用 + 空间」。三者任何一个变了，游标与快照都作废：
   * 不同中继实现的游标互不通用，同名空间在另一个中继上也是另一份数据。
   */
  scope: string;
  head: HeadDoc | null;
  /** 以项目码为键；digest 是拉取时头部里的 `d`，变了才重读。 */
  projects: Record<string, { digest: string; hash: string; doc: ProjectDoc }>;
  host: DeviceDoc | null;
  cursor: string | null;
  /** 手机最后一次成功和中继通信的时间。 */
  syncedAt: string | null;
};

export function snapshotScope(pairing: { u: string; a: string; s: string }): string {
  // 用 JSON 数组而不是拼接：中继地址里出现分隔符也不会让两份不同的配置撞成同一个 scope。
  return JSON.stringify([pairing.u, pairing.a, pairing.s]);
}

export function emptySnapshot(spaceId: string, scope: string): Snapshot {
  return { spaceId, scope, head: null, projects: {}, host: null, cursor: null, syncedAt: null };
}

/** 换上新的头部，并丢掉头部里已经没有的项目。 */
export function applyHead(snapshot: Snapshot, head: HeadDoc): Snapshot {
  const codes = new Set(head.projects.map((project) => project.code));
  const projects = Object.fromEntries(
    Object.entries(snapshot.projects).filter(([code]) => codes.has(code)),
  );
  return { ...snapshot, head, projects };
}

/** 头部里摘要变了（或本地还没有）的项目：这些需要重读。 */
export function projectsToFetch(snapshot: Snapshot): ProjectHead[] {
  if (!snapshot.head) return [];
  return snapshot.head.projects.filter(
    (project) => snapshot.projects[project.code]?.digest !== project.d,
  );
}

export function applyProject(snapshot: Snapshot, head: ProjectHead, doc: ProjectDoc): Snapshot {
  if (doc.code !== head.code) return snapshot;
  return {
    ...snapshot,
    projects: { ...snapshot.projects, [head.code]: { digest: head.d, hash: head.h, doc } },
  };
}

/** 项目文档被电脑删除（或读不到了）：去掉本地副本，下次头部指向它时再拉。 */
export function dropProjectByHash(snapshot: Snapshot, hash: string): Snapshot {
  const entry = Object.entries(snapshot.projects).find(([, value]) => value.hash === hash);
  if (!entry) return snapshot;
  const projects = { ...snapshot.projects };
  delete projects[entry[0]];
  return { ...snapshot, projects };
}

export function projectHeadByHash(snapshot: Snapshot, hash: string): ProjectHead | null {
  return snapshot.head?.projects.find((project) => project.h === hash) ?? null;
}

export function findTask(snapshot: Snapshot, code: string, key: string): TaskCard | null {
  return snapshot.projects[code]?.doc.tasks.find((task) => task.key === key) ?? null;
}

// ─── 分组与排序 ───

export type TaskGroupId = "active" | "ready" | "waiting" | "done";

export type TaskGroup = { id: TaskGroupId; label: string; tasks: TaskCard[] };

const GROUPS: ReadonlyArray<{ id: TaskGroupId; label: string; statuses: readonly string[] }> = [
  { id: "active", label: "进行中", statuses: ["IN_PROGRESS", "VERIFYING", "CLAIMED"] },
  { id: "ready", label: "待领取", statuses: ["READY", "BACKLOG"] },
  { id: "waiting", label: "等待与阻塞", statuses: ["WAITING_USER", "BLOCKED", "WAITING_AGENT"] },
  { id: "done", label: "最近完成", statuses: ["DONE", "CANCELLED"] },
];

const PRIORITY_RANK: Record<string, number> = { CRITICAL: 0, HIGH: 1, NORMAL: 2, LOW: 3 };

function time(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function newestFirst(left: TaskCard, right: TaskCard): number {
  return time(right.updatedAt) - time(left.updatedAt) || left.key.localeCompare(right.key);
}

function byStatusOrder(statuses: readonly string[]) {
  return (left: TaskCard, right: TaskCard) =>
    statuses.indexOf(left.status) - statuses.indexOf(right.status);
}

function byPriority(left: TaskCard, right: TaskCard): number {
  return (PRIORITY_RANK[left.priority] ?? 9) - (PRIORITY_RANK[right.priority] ?? 9);
}

/**
 * 项目页的四组：进行中 / 待领取 / 等待与阻塞 / 最近完成。
 *
 * - 进行中：待验收排在进行中之后、已认领之前；同状态按最近更新。
 * - 待领取：先看优先级，再看最近更新——手机上最常做的事是挑一个交给 Claude。
 * - 等待与阻塞：等你处理的排最前（那是真正需要手机主人动手的），其次受阻、等其他 Agent。
 * - 最近完成：按完成时间倒序。
 *
 * 空组也返回（界面决定是否隐藏），组的顺序固定。
 */
export function groupTasks(tasks: readonly TaskCard[]): TaskGroup[] {
  return GROUPS.map((group) => {
    const members = tasks.filter((task) => group.statuses.includes(task.status));
    const status = byStatusOrder(group.statuses);
    const sorted = [...members].sort((left, right) => {
      switch (group.id) {
        case "active":
          return status(left, right) || newestFirst(left, right);
        case "ready":
          return byPriority(left, right) || newestFirst(left, right);
        case "waiting":
          return status(left, right) || byPriority(left, right) || newestFirst(left, right);
        case "done":
          return newestFirst(left, right);
      }
    });
    return { id: group.id, label: group.label, tasks: sorted };
  });
}

/** 项目卡片上的四段比例条：已完成 / 进行中 / 等你与受阻 / 可开始。 */
export function projectSegments(project: ProjectHead): Array<{
  id: "done" | "active" | "waiting" | "ready";
  value: number;
}> {
  const { counts } = project;
  return [
    { id: "done" as const, value: counts.doneRecent },
    { id: "active" as const, value: counts.inProgress },
    { id: "waiting" as const, value: counts.blocked + counts.waitingUser },
    { id: "ready" as const, value: counts.ready },
  ].filter((segment) => segment.value > 0);
}

/**
 * 总览里项目的顺序：有事要你处理的在前，其次按最近更新。
 * 电脑端项目顺序是用户自己拖出来的，但快照里没有带，这里给一个对手机有用的默认。
 */
export function sortProjects(projects: readonly ProjectHead[]): ProjectHead[] {
  return [...projects].sort(
    (left, right) =>
      Number(right.counts.waitingUser + right.counts.blocked > 0) -
        Number(left.counts.waitingUser + left.counts.blocked > 0) ||
      time(right.updatedAt) - time(left.updatedAt) ||
      left.code.localeCompare(right.code),
  );
}

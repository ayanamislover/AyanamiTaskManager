import { createHash } from "node:crypto";
import type { AyanamiTaskService } from "@ayanami-task/application";
import { AtmError } from "@ayanami-task/errors";
import {
  TASK_KEY_PATTERN,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
  type HeadDoc,
  type ProjectCounts,
  type ProjectDoc,
  type ProjectHead,
  type TaskCard,
} from "@ayanami-task/sync-protocol";
import type { DispatchPort, SyncDispatchRun } from "./dispatch-port.js";

// 快照：把 ATM 的项目与任务映射成 docs/mobile-sync.md §5 的 ProjectDoc / ProjectHead。

/** 已关闭任务只带最近 14 天内的，至多 30 个，且不带详情字段（派单结果照带）。 */
export const CLOSED_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const CLOSED_LIMIT = 30;
/** 协议上限 5000 张卡片，给已关闭的留出余量。 */
export const OPEN_TASK_LIMIT = 4900;

const LIMITS = {
  title: 500,
  projectName: 200,
  desc: 2000,
  acceptance: 12,
  acceptanceItem: 500,
  reason: 500,
  agent: 128,
  recent: 3,
  summary: 500,
  /** 派单失败原因（协议上限 200）。 */
  dispatchError: 200,
} as const;

type WorkItemDetail = Awaited<ReturnType<AyanamiTaskService["getWorkItemForUi"]>>;
type WorkItemRow = Awaited<ReturnType<AyanamiTaskService["listWorkItemsForUi"]>>[number];

/**
 * 截断到 max 个 UTF-16 单元（与 zod 的 max 同一口径），不把代理对劈开，末尾加省略号。
 * 结果按码点数也不超过 max（码点数 ≤ UTF-16 单元数）。
 */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, sortKeys(entry)]),
    );
  }
  return value;
}

/** 规范化 JSON：键按字典序、丢掉 undefined。同样的内容永远得到同样的字符串。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function contentDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function oneOf<T extends string>(values: readonly T[], value: string, fallback: T): T {
  return (values as readonly string[]).includes(value) ? (value as T) : fallback;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const IN_PROGRESS = new Set(["CLAIMED", "IN_PROGRESS", "VERIFYING"]);

function baseCard(item: WorkItemRow): TaskCard {
  const status = oneOf(TASK_STATUSES, item.status, "BACKLOG");
  const card: TaskCard = {
    key: item.key,
    title: clipText(item.title, LIMITS.title),
    type: oneOf(TASK_TYPES, item.type, "TASK"),
    status,
    priority: oneOf(TASK_PRIORITIES, item.priority, "NORMAL"),
    progress: Math.min(100, Math.max(0, Number.isFinite(item.progress) ? item.progress : 0)),
    updatedAt: item.updatedAt,
  };
  if (item.parentKey && TASK_KEY_PATTERN.test(item.parentKey)) card.parent = item.parentKey;
  if ((status === "WAITING_USER" || status === "WAITING_AGENT") && item.waitingFor)
    card.waiting = clipText(item.waitingFor, LIMITS.reason);
  if (status === "BLOCKED") {
    const reason = item.blockedReason ?? item.progressBreakdown.blocker;
    if (reason) card.blocked = clipText(reason, LIMITS.reason);
  }
  return card;
}

async function openCard(
  service: AyanamiTaskService,
  code: string,
  item: WorkItemRow,
  dispatch: DispatchPort | null,
): Promise<TaskCard> {
  const card = baseCard(item);
  let detail: WorkItemDetail;
  try {
    detail = await service.getWorkItemForUi(code, item.key);
  } catch (error) {
    // 列表与详情之间任务被归档了：只发基本卡片，下一次变化事件会再重建。
    if (error instanceof AtmError && error.code === "WORK_ITEM_NOT_FOUND") return card;
    throw error;
  }
  if (detail.claimedBySessionId) {
    const agent = detail.executionSession?.agent_id;
    const since = detail.lastStartedAt ?? detail.everClaimedAt;
    card.claim = {
      agent: clipText(typeof agent === "string" && agent ? agent : "未知 Agent", LIMITS.agent),
      ...(since ? { since } : {}),
    };
  }
  if (detail.description.trim()) card.desc = clipText(detail.description, LIMITS.desc);
  const acceptance = detail.acceptance
    .filter((entry) => entry.trim())
    .slice(0, LIMITS.acceptance)
    .map((entry) => clipText(entry, LIMITS.acceptanceItem));
  if (acceptance.length > 0) card.acceptance = acceptance;
  const counted = detail.checklist.filter((entry) => entry.status !== "SKIPPED");
  if (counted.length > 0)
    card.checklist = {
      done: counted.filter((entry) => entry.status === "DONE").length,
      total: counted.length,
    };
  const recent = await service.recentTaskProgress(code, item.key, LIMITS.recent);
  if (recent.length > 0)
    card.recent = recent.slice(0, LIMITS.recent).map((entry) => ({
      at: entry.createdAt,
      summary: clipText(entry.summary, LIMITS.summary),
      ...(entry.percent === null ? {} : { percent: Math.min(100, Math.max(0, entry.percent)) }),
    }));
  return withDispatch(card, code, dispatch);
}

/**
 * 已关闭的任务不带详情，但带派单结果：手机发出的任务做完之后，发送卡片和任务页
 * 还要能显示「Claude 已完成」，否则只剩回执里接单那一刻的「排队中」。
 */
function closedCard(code: string, item: WorkItemRow, dispatch: DispatchPort | null): TaskCard {
  return withDispatch(baseCard(item), code, dispatch);
}

function withDispatch(card: TaskCard, code: string, dispatch: DispatchPort | null): TaskCard {
  const run = dispatch?.runForTask(code, card.key) ?? null;
  if (run) card.dispatch = dispatchCard(run);
  return card;
}

/** 只有失败的派单带原因（例如「Claude Code 未登录…」），截到 200；其它状态不带。 */
function dispatchCard(run: SyncDispatchRun): NonNullable<TaskCard["dispatch"]> {
  const error = run.state === "failed" ? run.error?.trim() : undefined;
  return {
    state: run.state,
    at: run.at,
    run: clipText(run.run, 64),
    ...(error ? { error: clipText(error, LIMITS.dispatchError) } : {}),
  };
}

export type ProjectSnapshot = {
  /** 项目文档里除 `at` 以外的部分；摘要就按它算。 */
  body: Omit<ProjectDoc, "at">;
  digest: string;
  counts: ProjectCounts;
  /** 最近一次任务变化时间；项目里一个任务都没有时为 null。 */
  updatedAt: string | null;
};

/** 读一个项目：全部未关闭任务（带详情）+ 14 天内关闭的至多 30 个（不带详情，只带派单结果）。 */
export async function buildProjectSnapshot(
  service: AyanamiTaskService,
  project: { code: string; name: string },
  dispatch: DispatchPort | null,
  now: Date,
): Promise<ProjectSnapshot> {
  const open = (await service.listWorkItemsForUi(project.code, { closed: false })).slice(
    0,
    OPEN_TASK_LIMIT,
  );
  const closedPage = await service.listRecentClosedWorkItemPageForUi(project.code, {
    limit: CLOSED_LIMIT,
  });
  const cutoff = now.getTime() - CLOSED_WINDOW_MS;
  const closed = closedPage.items.filter((item) => Date.parse(item.updatedAt) >= cutoff);
  const tasks: TaskCard[] = [];
  for (const [index, item] of open.entries()) {
    // 同步读库会占住主进程，大项目分批让出事件循环。
    if (index > 0 && index % 25 === 0) await yieldToEventLoop();
    tasks.push(await openCard(service, project.code, item, dispatch));
  }
  for (const item of closed) tasks.push(closedCard(project.code, item, dispatch));
  const counts: ProjectCounts = {
    active: open.length,
    ready: open.filter((item) => item.status === "READY").length,
    inProgress: open.filter((item) => IN_PROGRESS.has(item.status)).length,
    blocked: open.filter((item) => item.status === "BLOCKED").length,
    waitingUser: open.filter((item) => item.status === "WAITING_USER").length,
    doneRecent: closed.filter((item) => item.status === "DONE").length,
  };
  const body = {
    v: 1 as const,
    code: project.code,
    name: clipText(project.name, LIMITS.projectName),
    tasks,
  };
  const updatedAt = tasks.reduce<string | null>(
    (latest, task) => (latest === null || task.updatedAt > latest ? task.updatedAt : latest),
    null,
  );
  return { body, digest: contentDigest(body), counts, updatedAt };
}

export function projectHeadOf(
  snapshot: ProjectSnapshot,
  hash: string,
  fallbackAt: string,
): ProjectHead {
  return {
    code: snapshot.body.code,
    name: snapshot.body.name,
    h: hash,
    d: snapshot.digest,
    counts: snapshot.counts,
    updatedAt: snapshot.updatedAt ?? fallbackAt,
  };
}

/** head 除 `at` 以外的部分与它的摘要。项目按项目码排序，摘要不受发布顺序影响。 */
export function buildHeadBody(input: {
  host: HeadDoc["host"];
  dispatch: HeadDoc["dispatch"];
  projects: ProjectHead[];
}): { body: Omit<HeadDoc, "at">; digest: string } {
  const body = {
    v: 1 as const,
    host: input.host,
    dispatch: input.dispatch,
    projects: [...input.projects].sort((left, right) => left.code.localeCompare(right.code)),
  };
  return { body, digest: contentDigest(body) };
}

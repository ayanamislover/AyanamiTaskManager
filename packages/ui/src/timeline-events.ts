const eventLabels: Record<string, string> = {
  "quick.created": "创建临时任务",
  "quick.updated": "更新临时任务",
  "quick.promoted": "临时任务已晋升",
  "project.creating": "开始创建项目",
  "project.created": "项目已创建",
  "project.archived": "项目已归档",
  "project.restored": "项目已恢复",
  "project.restore_requested": "Agent 请求恢复项目",
  "project.restore_approved": "已授权恢复项目",
  "project.restore_rejected": "已拒绝恢复项目",
  "project.summary.updated": "项目摘要已更新",
  "project.trashed": "项目已移入垃圾箱",
  "project.update.drafted": "项目更新草稿已生成",
  "project.update.published": "项目更新已发布",
  "objective.created": "目标已创建",
  "milestone.created": "里程碑已创建",
  "work.created": "任务已创建",
  "work.started": "任务已开始",
  "work.claimed": "任务已领取",
  "work.blocked": "任务进入阻塞",
  "work.waiting": "任务进入等待",
  "work.completed": "任务已完成",
  "work.cancelled": "任务已取消",
  "work.reopened": "任务已重新打开",
  "work.verification_requested": "任务已提交验收",
  "work.progressed": "任务进度已更新",
  "progress.added": "任务进度已更新",
  "project.progress.added": "项目进度已更新",
  "checklist.updated": "检查项已更新",
  "record.created": "项目记录已创建",
  "agent.joined": "Agent 已加入",
  "agent.resumed": "Agent 已接回会话",
  "agent.left": "Agent 已离开",
  "agent.git_context.updated": "Agent Git 上下文已刷新",
  "backup.created": "备份已创建",
  "backup.restored": "备份已恢复",
  "database.recovered": "项目数据库已恢复",
  "import.agenttask.applied": "旧任务账本已导入",
};

export interface TimelineEventPresentation {
  id: string;
  sequence: number | null;
  type: string;
  category: string;
  title: string;
  detail: string | null;
  projectCode: string | null;
  projectName: string | null;
  subjectKey: string | null;
  actor: string | null;
  occurredAt: string | null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numeric(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function eventLabel(code: string): string {
  return eventLabels[code] ?? "项目发生变化";
}

export function presentTimelineEvent(event: Record<string, unknown>): TimelineEventPresentation {
  const type = text(event.type) ?? "unknown";
  const sequence = numeric(event.sequence ?? event.seq);
  const category = eventLabel(type);
  const title = text(event.title) ?? text(event.summary) ?? category;
  const projectCode = text(event.projectCode ?? event.project_code);
  const projectName = text(event.projectName ?? event.project_name);
  const subjectKey = text(event.key ?? event.subjectKey ?? event.workItemKey ?? event.taskKey);
  const actor = text(event.actor ?? event.actor_id);
  const occurredAt = text(event.created_at ?? event.createdAt ?? event.at);

  return {
    id: String(sequence ?? text(event.id) ?? `${type}:${occurredAt ?? title}`),
    sequence,
    type,
    category,
    title,
    detail: text(event.detail),
    projectCode,
    projectName,
    subjectKey,
    actor,
    occurredAt,
  };
}

const SYSTEM_EVENT_TYPES = new Set([
  "project.creating",
  "project.summary.updated",
  "agent.git_context.updated",
  "database.recovered",
]);

/**
 * 系统自己产生的簿记事件：自动备份、项目创建的中间步骤、摘要重算、Git 上下文刷新。
 * 近 7 天 1392 条全局事件里光 backup.created 就占 11.3%，混在任务变化中间是噪声，
 * 时间线默认隐藏，勾选「显示系统事件」才出现。
 */
export function isSystemTimelineEvent(event: Record<string, unknown>): boolean {
  const type = text(event.type) ?? "";
  const actor = text(event.actor ?? event.actor_id);
  return actor === "SYSTEM" || type.startsWith("backup.") || SYSTEM_EVENT_TYPES.has(type);
}

// 26 位 Crockford Base32 的 ULID：项目、目标等内部 id，对人没有意义。
const INTERNAL_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

/** 时间线上要显示的业务键；内部 id 和已经写在正文里的键都不再单独重复一遍。 */
export function visibleSubjectKey(item: TimelineEventPresentation): string | null {
  if (!item.subjectKey || INTERNAL_ID.test(item.subjectKey)) return null;
  if (item.detail?.includes(item.subjectKey)) return null;
  return item.subjectKey;
}

export function timelineActorLabel(actor: string | null): string | null {
  if (!actor) return null;
  if (actor === "SYSTEM") return "系统";
  if (actor === "USER") return "桌面用户";
  return actor;
}

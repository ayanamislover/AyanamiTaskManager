export type EventProjectContext = {
  id: string;
  code: string;
  name: string;
};

export type EventPresentationInput = {
  type: string;
  aggregateType?: string | null;
  aggregateId?: string | null;
  actor?: string | null;
  payload?: Record<string, unknown> | null;
  project?: EventProjectContext | null;
};

export type PresentedEvent = {
  type: string;
  key: string | null;
  summary: string;
  actor: string;
  title: string;
  detail: string;
  project: EventProjectContext | null;
};

const EVENT_TITLES: Record<string, string> = {
  "agent.joined": "Agent 加入",
  "agent.left": "Agent 离开",
  "agent.force_closed": "Agent 会话关闭",
  "agent.recovered_stale": "回收过期 Agent 声明",
  "agent.git_context.updated": "刷新 Git 上下文",
  "backup.created": "创建备份",
  "backup.failed": "备份失败",
  "backup.restored": "恢复备份",
  "checklist.batch_updated": "批量更新验收清单",
  "checklist.updated": "更新验收清单",
  "milestone.created": "创建里程碑",
  "objective.created": "创建目标",
  "project.creating": "开始创建项目",
  "project.created": "创建项目",
  "project.path.attached": "关联项目路径",
  "project.update.drafted": "草拟项目摘要",
  "project.update.published": "发布项目摘要",
  "project.archived": "归档项目",
  "project.restored": "恢复项目",
  "project.trashed": "移入回收站",
  "record.created": "新增记录",
  "setting.updated": "更新设置",
  "quick.created": "创建临时任务",
  "quick.updated": "更新临时任务",
  "quick.promoted": "提升为项目任务",
  "work.blocked": "任务受阻",
  "work.cancelled": "取消任务",
  "work.claimed": "领取任务",
  "work.completed": "完成任务",
  "work.created": "创建任务",
  "work.moved": "移动任务",
  "work.progressed": "更新任务进度",
  "work.released": "释放任务",
  "work.reopened": "重新打开任务",
  "work.started": "开始任务",
  "work.updated": "更新任务",
  "work.verification_requested": "请求任务验收",
  "work.waiting": "任务进入等待",
  "import.agenttask.applied": "导入 AgentTask",
};

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function percent(value: unknown): string | null {
  const number = asNumber(value);
  return number === null ? null : `${number}%`;
}

function fallbackTitle(type: string): string {
  return (
    EVENT_TITLES[type] ??
    type
      .split(".")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

function workDetail(type: string, key: string, payload: Record<string, unknown>): string {
  const title = asText(payload.title) ?? asText(payload.taskTitle);
  const label = title ? `${key}「${title}」` : key;
  const status = asText(payload.status);
  const summary = asText(payload.summary);
  const operation = asText(payload.operation);
  switch (type) {
    case "work.created":
      return `创建任务 ${label}${status ? `，初始状态 ${status}` : ""}`;
    case "work.progressed":
    case "work.blocked": {
      const from = percent(payload.from);
      const to = percent(payload.to);
      const progress = from || to ? `（${from ?? "—"} → ${to ?? "—"}）` : "";
      return `${label} 更新进度${progress}${summary ? `：${summary}` : ""}`;
    }
    case "work.completed":
      return `完成任务 ${label}`;
    case "work.started":
      return `开始执行 ${label}`;
    case "work.claimed":
      return `领取任务 ${label}`;
    case "work.released":
      return `释放任务 ${label}`;
    case "work.verification_requested":
      return `请求验收 ${label}`;
    case "work.waiting":
      return `${label} 进入等待${summary ? `：${summary}` : ""}`;
    case "work.cancelled":
      return `取消任务 ${label}`;
    case "work.reopened":
      return `重新打开 ${label}`;
    case "work.moved":
      return `移动任务 ${label}`;
    default:
      return `${label}${operation ? `（${operation}）` : ""}${status ? `，状态 ${status}` : ""}${summary ? `：${summary}` : ""}`;
  }
}

function detailFor(
  input: EventPresentationInput,
  payload: Record<string, unknown>,
  key: string,
): string {
  const type = input.type;
  if (type.startsWith("work.")) return workDetail(type, key, payload);
  if (type === "record.created") {
    const title = asText(payload.title);
    const summary = asText(payload.summary);
    const kind = asText(payload.kind);
    return `${kind === "DECISION" ? "记录决策" : "新增记录"} ${key}${title ? `「${title}」` : ""}${summary ? `：${summary}` : ""}`;
  }
  if (type === "project.update.published" || type === "project.update.drafted") {
    const summary = asText(payload.summary);
    return `${summary ? `项目摘要：${summary}` : "项目摘要已更新"}`;
  }
  if (type === "checklist.updated") {
    const status = asText(payload.status);
    const taskKey = asText(payload.taskKey);
    return `验收清单${taskKey ? `（${taskKey}）` : ""}${status ? `状态变为 ${status}` : "已更新"}`;
  }
  if (type === "checklist.batch_updated") {
    const taskKey = asText(payload.taskKey) ?? key;
    const count = Array.isArray(payload.items) ? payload.items.length : null;
    return `批量更新验收清单${taskKey ? `（${taskKey}）` : ""}${count === null ? "" : `：${count} 项`}`;
  }
  if (type === "agent.joined") {
    const agent = asText(payload.agentId) ?? input.actor ?? key;
    const role = asText(payload.role);
    return `${agent} 加入${role ? `（${role}）` : ""}`;
  }
  if (type === "agent.left" || type === "agent.force_closed") {
    const agent = asText(payload.agentId) ?? input.actor ?? key;
    const summary = asText(payload.summary);
    return `${agent} 结束会话${summary ? `：${summary}` : ""}`;
  }
  if (type === "agent.git_context.updated") {
    const branch = asText(payload.branch);
    const head = asText(payload.head);
    const dirty = asBoolean(payload.dirty);
    const agent = asText(payload.agentId) ?? input.actor ?? key;
    return `${agent} 的 Git 上下文${branch ? `：分支 ${branch}` : ""}${head ? `，HEAD ${head.slice(0, 8)}` : ""}${dirty === null ? "" : dirty ? "，工作区有改动" : "，工作区干净"}`;
  }
  if (type.startsWith("backup.")) {
    const scope = asText(payload.scope);
    const reason = asText(payload.reason);
    const code = asText(payload.code);
    return `${scope ? `${scope} ` : ""}备份${reason ? `（${reason}）` : ""}${code ? `：${code}` : ""}`;
  }
  if (type === "objective.created" || type === "milestone.created") {
    const title = asText(payload.title);
    return `${fallbackTitle(type)}${title ? `「${title}」` : ""}`;
  }
  const summary = asText(payload.summary) ?? asText(payload.title) ?? asText(payload.name);
  return summary ?? `${fallbackTitle(type)}${key ? `（${key}）` : ""}`;
}

/** Convert a persisted event into stable, human-readable timeline fields. */
export function presentEvent(input: EventPresentationInput): PresentedEvent {
  const payload = input.payload ?? {};
  const aggregateId = asText(input.aggregateId);
  const key = asText(payload.key) ?? aggregateId;
  const actor = asText(input.actor) ?? "SYSTEM";
  const title =
    input.type === "record.created" && asText(payload.kind) === "DECISION"
      ? "记录决策"
      : fallbackTitle(input.type);
  const detail = detailFor(input, payload, key ?? "");
  return {
    type: input.type,
    key,
    summary: detail,
    actor,
    title,
    detail,
    project: input.project ?? null,
  };
}

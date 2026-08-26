export type TaskProgressInput = {
  status?: unknown;
  phase?: unknown;
  waitingOn?: unknown;
  waitingFor?: unknown;
  blockedReason?: unknown;
  progress?: unknown;
  reportedProgress?: unknown;
  progressSource?: unknown;
  checklist?: unknown;
};

const phaseLabels: Record<string, string> = {
  BACKLOG: "待规划",
  READY: "待开始",
  CLAIMED: "已领取",
  IN_PROGRESS: "执行中",
  BLOCKED: "受阻",
  VERIFYING: "验收中",
  DONE: "已完成",
  CANCELLED: "已取消",
};

const waitingLabels: Record<string, string> = {
  AGENT: "等待 Agent",
  USER: "等待用户",
  EXTERNAL: "等待外部条件",
};

const finiteNumber = (value: unknown): number | null => {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
};

export function taskProgressPresentation(task: TaskProgressInput) {
  const status = String(task.status ?? "BACKLOG");
  const legacyWaiting =
    status === "WAITING_AGENT" ? "AGENT" : status === "WAITING_USER" ? "USER" : null;
  const waitingOn = task.waitingOn ? String(task.waitingOn) : legacyWaiting;
  // 旧数据把等待对象编码进 status，无法恢复等待前的精确阶段。明确标成兼容推断，
  // 至少不再让 WAITING_* 同时冒充工作阶段。
  const phase = task.phase ? String(task.phase) : legacyWaiting ? "IN_PROGRESS" : status;
  const checklist = Array.isArray(task.checklist)
    ? (task.checklist as Array<Record<string, unknown>>)
    : [];
  const totalWeight = checklist.reduce((sum, item) => sum + (finiteNumber(item.weight) ?? 1), 0);
  const completed = checklist.filter((item) => ["DONE", "SKIPPED"].includes(String(item.status)));
  const doneWeight = completed.reduce((sum, item) => sum + (finiteNumber(item.weight) ?? 1), 0);
  const baseLabel = phaseLabels[phase] ?? phase;
  const waitLabel = waitingOn ? (waitingLabels[waitingOn] ?? `等待 ${waitingOn}`) : null;
  const blockedReason = typeof task.blockedReason === "string" ? task.blockedReason.trim() : "";
  const waitingFor = typeof task.waitingFor === "string" ? task.waitingFor.trim() : "";

  return {
    phase,
    waitingOn,
    phaseLabel: waitLabel ? `${baseLabel} · ${waitLabel}` : baseLabel,
    computed: finiteNumber(task.progress) ?? 0,
    reported: finiteNumber(task.reportedProgress),
    source: String(task.progressSource ?? "NONE"),
    doneWeight,
    totalWeight,
    doneStages: completed.length,
    totalStages: checklist.length,
    blocker: blockedReason || waitingFor || null,
  };
}

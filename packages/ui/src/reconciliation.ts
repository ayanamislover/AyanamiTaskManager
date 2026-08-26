import type { ReconciliationClassification } from "@ayanami-task/client";

const LABELS: Record<ReconciliationClassification, string> = {
  ACTIVE: "正常",
  LEASE_EXPIRED_ONLINE: "在线但领取过期",
  STALLED: "任务停滞",
  POSSIBLY_COMPLETE: "可能已完成",
};

export function reconciliationLabel(classification: ReconciliationClassification): string {
  return LABELS[classification];
}

export function reconciliationSummary(result: { attentionCount: number } | undefined): string {
  if (!result) return "正在检查需对账项…";
  return result.attentionCount === 0 ? "无需对账" : `需对账 ${result.attentionCount} 项`;
}

export function formatReconciliationAge(seconds: number): string {
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时`;
  return `${Math.floor(seconds / 86_400)} 天`;
}

import { WORK_ITEM_STATUS_LABELS } from "@ayanami-task/protocol";
import type { AgentIntegrationReport, AgentIntegrationState, McpClient } from "./contracts.js";

export const statusLabels: Record<string, string> = {
  ...WORK_ITEM_STATUS_LABELS,
  OPEN: "待处理",
  PROMOTED: "已晋升",
  ARCHIVED: "已归档",
  TRASHED: "垃圾箱",
  ACTIVE: "活动",
  ON_TRACK: "正常",
  AT_RISK: "有风险",
  OFF_TRACK: "偏离计划",
  UNKNOWN: "未知",
  ONLINE: "在线",
  CLOSED: "已关闭",
  PRIMARY: "主 Agent",
  SUBAGENT: "子 Agent",
  REVIEWER: "审阅者",
  OBSERVER: "观察者",
  SOLO: "单 Agent",
  AUTO: "自动判断",
  MULTI: "多 Agent",
};

export const priorityLabels: Record<string, string> = {
  LOW: "低",
  NORMAL: "普通",
  HIGH: "高",
  CRITICAL: "紧急",
};

export const progressSourceLabels: Record<string, string> = {
  NONE: "尚无进度",
  CHECKLIST: "检查项计算",
  CHILDREN: "子任务汇总",
  REPORTED: "人工报告",
  STATUS: "状态计算",
};

export function statusClass(status: string): string {
  if (["DONE", "ACTIVE", "ON_TRACK"].includes(status)) return "success";
  if (["BLOCKED", "OFF_TRACK", "MIGRATION_FAILED"].includes(status)) return "danger";
  if (["WAITING_USER", "WAITING_AGENT", "AT_RISK"].includes(status)) return "warning";
  if (["IN_PROGRESS", "CLAIMED", "READY", "VERIFYING"].includes(status)) return "primary";
  return "";
}

export function Status({ value }: { value: string }) {
  return <span className={`atm-badge ${statusClass(value)}`}>{statusLabels[value] ?? value}</span>;
}

export function formatTime(value?: string | null): string {
  if (!value) return "暂无";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function compactPath(value?: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "不可用";
  const parts = value.replaceAll("/", "\\").split("\\").filter(Boolean);
  return parts.length > 2 ? `…\\${parts.slice(-2).join("\\")}` : value;
}

export function formatDuration(value?: string | null): string {
  const started = Date.parse(value ?? "");
  if (!Number.isFinite(started)) return "未知";
  const minutes = Math.max(0, Math.floor((Date.now() - started) / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

export function sidebarProjectHint(name: string): string {
  const isLongAsciiName =
    name.length > 28 &&
    /[A-Za-z]/u.test(name) &&
    Array.from(name).every((character) => (character.codePointAt(0) ?? 0) <= 0x7f);
  return isLongAsciiName ? `${name}\n名称较长，建议改用简洁中文名称。` : name;
}

export const integrationStateLabels: Record<AgentIntegrationState, string> = {
  NOT_INSTALLED: "未安装",
  INSTALLED: "已安装",
  NEEDS_UPDATE: "需要更新",
  MODIFIED: "内容被修改",
};

export function AgentIntegrationBadge({ state }: { state: AgentIntegrationState }) {
  return (
    <span className="atm-integration-status" data-state={state}>
      {integrationStateLabels[state]}
    </span>
  );
}

export function integrationState(report: AgentIntegrationReport): AgentIntegrationState {
  const states = [report.rule.state, report.skills.state];
  if (states.includes("MODIFIED")) return "MODIFIED";
  if (states.includes("NEEDS_UPDATE")) return "NEEDS_UPDATE";
  if (report.mcpInstalled && states.every((state) => state === "INSTALLED")) return "INSTALLED";
  return "NOT_INSTALLED";
}

export function agentClientLabel(client: McpClient): string {
  if (client === "CODEX") return "Codex";
  if (client === "CLAUDE_CODE") return "Claude Code";
  return "Claude Desktop";
}

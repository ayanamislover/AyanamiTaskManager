import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  ATM_INTEGRATION_VERSION,
  type AgentIntegrationState,
  type AgentRuleAction,
} from "./contracts.js";
import { replaceFileWithBackup } from "./atomic-files.js";

export const AGENT_RULE_SNIPPET =
  "执行项目前先访问 ATM 工具，并阅读 %LOCALAPPDATA%\\AyanamiTaskManager\\ATM_AGENT_GUIDE.md；后续所有任务执行均依赖 ATM。受管开发任务开始实现前必须按可交付结果和可验证验收拆分成可独立验收的工作项。";

const managedRuleBegin = "<!-- AYANAMI_TASK_MANAGER:BEGIN -->";
const managedRuleEnd = "<!-- AYANAMI_TASK_MANAGER:END -->";
const managedRulePayload = `## AyanamiTaskManager

- ATM 是受管开发项目的计划、任务状态、长期记录和 Session 交接事实源。
- 复杂任务形成执行计划后，必须把可独立交付/验证的主要步骤同步为 ATM WorkItem，不能只登记最高层目标。
- 实际执行优先领取 READY 的叶子 WorkItem；Objective / Milestone / EPIC 用于表达目标和范围。
- 开工使用一次 \`atm_begin\` 并直接使用其 brief；不要紧接 \`atm_brief\`。
- 仅在有意义状态变化时写 progress；长期决策/事实/风险写 record。
- 上下文恢复优先 ATM brief / delta，不重新扫描整个项目历史。
- 完整规则见 \`%LOCALAPPDATA%\\AyanamiTaskManager\\ATM_AGENT_GUIDE.md\`。`;

function managedRuleHash(version: number, payload: string): string {
  return createHash("sha256").update(`${version}\n${payload}`).digest("hex");
}

export function renderManagedAgentRule(): string {
  const hash = managedRuleHash(ATM_INTEGRATION_VERSION, managedRulePayload);
  return `${managedRuleBegin}
<!-- ATM-INTEGRATION-VERSION: ${ATM_INTEGRATION_VERSION} -->
<!-- ATM-INTEGRATION-HASH: ${hash} -->

${managedRulePayload}
${managedRuleEnd}`;
}

function managedRuleRange(content: string): { start: number; end: number; block: string } | null {
  const start = content.indexOf(managedRuleBegin);
  const endMarker = content.indexOf(managedRuleEnd, Math.max(0, start));
  if (start < 0 && endMarker < 0) return null;
  if (start < 0 || endMarker < start) {
    return {
      start: Math.max(0, start),
      end: content.length,
      block: content.slice(Math.max(0, start)),
    };
  }
  const end = endMarker + managedRuleEnd.length;
  return { start, end, block: content.slice(start, end) };
}

function contentWithoutManagedRule(content: string): string {
  const range = managedRuleRange(content);
  if (!range) return content;
  const before = content.slice(0, range.start).trimEnd();
  const after = content.slice(range.end).trimStart();
  const remaining = [before, after].filter(Boolean).join("\n\n");
  return remaining ? `${remaining}\n` : "";
}

function contentWithManagedRule(content: string): string {
  const base = contentWithoutManagedRule(content).trimEnd();
  return `${base}${base ? "\n\n" : ""}${renderManagedAgentRule()}\n`;
}

export function inspectManagedAgentRule(path: string): {
  state: AgentIntegrationState;
  path: string;
  version: number | null;
} {
  const content = existsSync(path) ? readFileSync(path, "utf8") : "";
  const range = managedRuleRange(content);
  if (!range) return { state: "NOT_INSTALLED", path, version: null };
  const versionMatch = /<!-- ATM-INTEGRATION-VERSION: (\d+) -->/u.exec(range.block);
  const hashMatch = /<!-- ATM-INTEGRATION-HASH: ([a-f0-9]{64}) -->/u.exec(range.block);
  const version = versionMatch ? Number(versionMatch[1]) : null;
  const payloadStart = hashMatch ? (hashMatch.index ?? 0) + hashMatch[0].length : -1;
  const payloadEnd = range.block.lastIndexOf(managedRuleEnd);
  const payload = payloadStart >= 0 ? range.block.slice(payloadStart, payloadEnd).trim() : "";
  if (version === null || !hashMatch || hashMatch[1] !== managedRuleHash(version, payload)) {
    return { state: "MODIFIED", path, version };
  }
  if (version !== ATM_INTEGRATION_VERSION) return { state: "NEEDS_UPDATE", path, version };
  return {
    state: range.block === renderManagedAgentRule() ? "INSTALLED" : "MODIFIED",
    path,
    version,
  };
}

export function manageAgentRule(input: { path: string; action: AgentRuleAction }): {
  state: AgentIntegrationState;
  path: string;
  backupPath: string | null;
  current: string;
  proposed: string;
} {
  const current = existsSync(input.path) ? readFileSync(input.path, "utf8") : "";
  const inspected = inspectManagedAgentRule(input.path);
  const proposed =
    input.action === "UNINSTALL"
      ? contentWithoutManagedRule(current)
      : contentWithManagedRule(current);
  if (input.action === "PREVIEW") return { ...inspected, backupPath: null, current, proposed };
  if (inspected.state === "MODIFIED" && input.action !== "REPAIR" && input.action !== "UNINSTALL") {
    throw new Error("AGENT_RULE_MODIFIED_REQUIRES_REPAIR");
  }
  if (input.action === "UPDATE" && inspected.state === "INSTALLED") {
    return { ...inspected, backupPath: null, current, proposed: current };
  }
  if (input.action === "INSTALL" && inspected.state === "NEEDS_UPDATE") {
    throw new Error("AGENT_RULE_NEEDS_EXPLICIT_UPDATE");
  }
  if (current === proposed) return { ...inspected, backupPath: null, current, proposed };
  const backupPath = replaceFileWithBackup(input.path, proposed);
  return {
    ...inspectManagedAgentRule(input.path),
    backupPath,
    current,
    proposed,
  };
}

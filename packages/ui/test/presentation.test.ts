import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AgentIntegrationBadge,
  Status,
  agentClientLabel,
  compactPath,
  formatDuration,
  formatTime,
  integrationState,
  priorityLabels,
  progressSourceLabels,
  sidebarProjectHint,
  statusClass,
  statusLabels,
} from "../src/presentation.js";

describe("UI presentation", () => {
  it("保持状态、优先级与进度来源文案", () => {
    expect(statusLabels).toMatchObject({ DONE: "已完成", ACTIVE: "活动", SUBAGENT: "子 Agent" });
    expect(priorityLabels).toEqual({ LOW: "低", NORMAL: "普通", HIGH: "高", CRITICAL: "紧急" });
    expect(progressSourceLabels).toEqual({
      NONE: "尚无进度",
      CHECKLIST: "检查项计算",
      CHILDREN: "子任务汇总",
      REPORTED: "人工报告",
      STATUS: "状态计算",
    });
    expect(statusClass("DONE")).toBe("success");
    expect(statusClass("BLOCKED")).toBe("danger");
    expect(statusClass("WAITING_USER")).toBe("warning");
    expect(statusClass("VERIFYING")).toBe("primary");
    expect(statusClass("UNKNOWN")).toBe("");
  });

  it("保持状态 badge 的 DOM、class 与回退文案", () => {
    expect(renderToStaticMarkup(createElement(Status, { value: "DONE" }))).toBe(
      '<span class="atm-badge success">已完成</span>',
    );
    expect(renderToStaticMarkup(createElement(Status, { value: "CUSTOM" }))).toBe(
      '<span class="atm-badge ">CUSTOM</span>',
    );
    expect(renderToStaticMarkup(createElement(AgentIntegrationBadge, { state: "MODIFIED" }))).toBe(
      '<span class="atm-integration-status" data-state="MODIFIED">内容被修改</span>',
    );
  });

  it("保持时间、时长、路径与长英文提示规则", () => {
    expect(formatTime(null)).toBe("暂无");
    expect(formatTime("invalid-time")).toBe("invalid-time");
    expect(compactPath("C:/one/two/three")).toBe("…\\two\\three");
    expect(compactPath(undefined)).toBe("不可用");
    expect(formatDuration("invalid-time")).toBe("未知");
    expect(sidebarProjectHint("AyanamiTaskManager")).toBe("AyanamiTaskManager");
    const longAscii = "AyanamiTaskManagerLongEnglishProject";
    expect(sidebarProjectHint(longAscii)).toBe(`${longAscii}\n名称较长，建议改用简洁中文名称。`);
  });

  it("保持 Agent integration 汇总优先级与客户端标签", () => {
    const base = {
      client: "CODEX" as const,
      mcpInstalled: true,
      repairError: null,
      sharesRuleAndSkillsWith: null,
      cliAvailable: true,
      rule: { state: "INSTALLED" as const, path: "rule", version: 1 },
      skills: { state: "INSTALLED" as const, skills: [] },
    };
    expect(integrationState(base)).toBe("INSTALLED");
    expect(integrationState({ ...base, rule: { ...base.rule, state: "NEEDS_UPDATE" } })).toBe(
      "NEEDS_UPDATE",
    );
    expect(integrationState({ ...base, skills: { ...base.skills, state: "MODIFIED" } })).toBe(
      "MODIFIED",
    );
    expect(agentClientLabel("CODEX")).toBe("Codex");
    expect(agentClientLabel("CLAUDE_CODE")).toBe("Claude Code");
    expect(agentClientLabel("CLAUDE")).toBe("Claude Desktop");
  });
});

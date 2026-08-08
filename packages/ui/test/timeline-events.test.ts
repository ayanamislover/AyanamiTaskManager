import { describe, expect, it } from "vitest";
import { presentTimelineEvent } from "../src/timeline-events.js";

describe("presentTimelineEvent", () => {
  it("preserves the normalized backend presentation", () => {
    expect(
      presentTimelineEvent({
        sequence: 42,
        type: "work.completed",
        title: "ATM-T-0049 已完成",
        detail: "Git Context 十类场景验收通过",
        projectCode: "ATM",
        projectName: "AyanamiTaskManager",
        key: "ATM-T-0049",
        actor: "codex-root",
        created_at: "2026-08-08T12:00:00.000Z",
      }),
    ).toEqual({
      id: "42",
      sequence: 42,
      type: "work.completed",
      category: "任务已完成",
      title: "ATM-T-0049 已完成",
      detail: "Git Context 十类场景验收通过",
      projectCode: "ATM",
      projectName: "AyanamiTaskManager",
      subjectKey: "ATM-T-0049",
      actor: "codex-root",
      occurredAt: "2026-08-08T12:00:00.000Z",
    });
  });

  it("keeps older project delta rows readable", () => {
    expect(
      presentTimelineEvent({
        seq: 7,
        type: "progress.added",
        summary: "完成 REST 与 E2E 验收",
        key: "ATM-T-0050",
        at: "2026-08-08T12:30:00.000Z",
      }),
    ).toMatchObject({
      id: "7",
      category: "任务进度已更新",
      title: "完成 REST 与 E2E 验收",
      subjectKey: "ATM-T-0050",
      occurredAt: "2026-08-08T12:30:00.000Z",
    });
  });

  it("uses a specific event label instead of the old generic summary fallback", () => {
    expect(presentTimelineEvent({ seq: 9, type: "agent.git_context.updated" })).toMatchObject({
      category: "Agent Git 上下文已刷新",
      title: "Agent Git 上下文已刷新",
    });
    expect(presentTimelineEvent({ seq: 10, type: "work.progressed" })).toMatchObject({
      category: "任务进度已更新",
      title: "任务进度已更新",
    });
  });
});

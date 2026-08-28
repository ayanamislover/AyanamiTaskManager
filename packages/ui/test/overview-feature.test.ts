import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AyanamiClient, RegisteredProject } from "@ayanami-task/client";
import { describe, expect, it, vi } from "vitest";
import { OverviewPage, TasksAcrossProjects } from "../src/features/overview.js";

const sourcePath = join(process.cwd(), "packages", "ui", "src", "features", "overview.tsx");

function client(): AyanamiClient {
  return {
    overview: vi.fn(),
    quick: {
      list: vi.fn(),
      patch: vi.fn(),
    },
    tasks: {
      pageForUi: vi.fn(),
    },
  } as unknown as AyanamiClient;
}

function project(): RegisteredProject {
  return {
    id: "project-id",
    code: "ATM",
    name: "AyanamiTaskManager",
    lifecycle: "ACTIVE",
  } as RegisteredProject;
}

function renderWithClient(
  queryClient: QueryClient,
  child: ReturnType<typeof createElement>,
): string {
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: queryClient }, child));
}

function missingOverviewContracts(source: string): string[] {
  const contracts = [
    'queryKey: ["overview"]',
    'queryKey: ["quick"]',
    'queryClient.invalidateQueries({ queryKey: ["quick"] })',
    'queryClient.invalidateQueries({ queryKey: ["overview"] })',
    '.filter((project) => project.lifecycle === "ACTIVE")',
    "client.tasks.pageForUi(project.code, {",
    "limit: 100",
    '["tasks", "all", "ui", ...sources.map((source) => source.key)]',
    '["CLAIMED", "IN_PROGRESS", "VERIFYING"]',
    '["BLOCKED", "WAITING_USER", "WAITING_AGENT"]',
    "onTask(task.project, task.key)",
  ];
  return contracts.filter((contract) => !source.includes(contract));
}

describe("Overview feature", () => {
  it("保持 overview 聚合、attention、项目、时间线与临时任务 DOM", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["overview"], {
      sequence: 42,
      projects: [
        {
          ...project(),
          active_count: 2,
          blocked_count: 1,
          waiting_user_count: 1,
          waiting_agent_count: 0,
          overdue_count: 0,
          stale_claim_count: 0,
          active_agent_count: 1,
          last_project_update_at: "2026-08-28T00:00:00.000Z",
          current_milestone: "桌面 UI",
          next_target_date: "2026-09-01",
          health: "ON_TRACK",
          progress: 75,
          progress_source: "STATUS_WEIGHTED",
          last_activity_at: "2026-08-28T00:00:00.000Z",
          projection: { status: "CAUGHT_UP", lag: 0 },
        },
      ],
      quick: { blocked: 1 },
      projectionFailures: [],
      recentEvents: [{ id: "event-1", type: "work.started", title: "开始实现" }],
    });
    queryClient.setQueryData(
      ["quick"],
      [{ id: "quick-1", key: "Q-1", title: "临时检查", status: "READY", version: 1 }],
    );
    const TimelineRow: ComponentType<{ event: Record<string, unknown> }> = ({ event }) =>
      createElement("div", { "data-testid": "timeline-row" }, String(event.title));

    const markup = renderWithClient(
      queryClient,
      createElement(OverviewPage, {
        client: client(),
        onProject: vi.fn(),
        onQuick: vi.fn(),
        notify: vi.fn(),
        TimelineEventRow: TimelineRow,
      }),
    );

    expect(markup).toContain("只显示已经写入事实源的项目状态，不展示模拟数据。");
    expect(markup).toContain("进行中项目");
    expect(markup).toContain("需要处理");
    expect(markup).toContain("AyanamiTaskManager");
    expect(markup).toContain("seq 42");
    expect(markup).toContain('data-testid="timeline-row"');
    expect(markup).toContain("临时检查");
  });

  it("保持跨项目 active/blocked 空态与局部分页入口", () => {
    const active = renderWithClient(
      new QueryClient(),
      createElement(TasksAcrossProjects, {
        client: client(),
        projects: [],
        mode: "active",
        onTask: vi.fn(),
      }),
    );
    const blocked = renderWithClient(
      new QueryClient(),
      createElement(TasksAcrossProjects, {
        client: client(),
        projects: [],
        mode: "blocked",
        onTask: vi.fn(),
      }),
    );

    expect(active).toContain("没有活动任务");
    expect(active).toContain("任务被领取或开始后会出现在这里。");
    expect(blocked).toContain("没有阻塞或等待");
    expect(blocked).toContain("当前没有需要外部处理的任务。");
  });

  it("query key、分页和状态集合守卫有阳性变异红灯", () => {
    const source = readFileSync(sourcePath, "utf8");
    expect(missingOverviewContracts(source)).toEqual([]);

    for (const contract of [
      'queryKey: ["overview"]',
      "limit: 100",
      '["BLOCKED", "WAITING_USER", "WAITING_AGENT"]',
    ]) {
      expect(missingOverviewContracts(source.replaceAll(contract, "MUTATED"))).toContain(contract);
    }
  });
});

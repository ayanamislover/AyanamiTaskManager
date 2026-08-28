import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AyanamiClient } from "@ayanami-task/client";
import { describe, expect, it, vi } from "vitest";
import { ProjectSummary } from "../src/features/project-summary.js";

const summaryPath = join(process.cwd(), "packages", "ui", "src", "features", "project-summary.tsx");
const reconcilePath = join(
  process.cwd(),
  "packages",
  "ui",
  "src",
  "features",
  "project-reconcile.tsx",
);

function client(): AyanamiClient {
  return {
    projects: {
      brief: vi.fn(),
      agents: vi.fn(),
      updates: vi.fn(),
      reconciliation: vi.fn(),
      reconcileProjection: vi.fn(),
      engineeringMetrics: vi.fn(),
    },
    overview: vi.fn(),
  } as unknown as AyanamiClient;
}

function renderSummary() {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["brief", "ATM"], {
    objective: "完成稳定版",
    milestone: "UI 模块化",
  });
  queryClient.setQueryData(["overview"], {
    projects: [
      {
        code: "ATM",
        health: "ON_TRACK",
        last_activity_at: "2026-08-28T00:00:00.000Z",
        progress: 64,
        progress_source: "TASKS",
        next_target_date: "2026-08-29",
        last_project_update_at: "2026-08-28T01:00:00.000Z",
        projection: {
          status: "APPLIED",
          sourceSeq: 20,
          projectedSeq: 20,
          lag: 0,
          retryCount: 0,
          updatedAt: "2026-08-28T01:00:00.000Z",
          lastError: null,
        },
      },
    ],
  });
  queryClient.setQueryData(
    ["agents", "ATM"],
    [
      {
        id: "session-1",
        displayName: "Codex UI",
        connectionState: "ONLINE",
        currentTaskKey: "ATM-T-0261",
        git: {
          branch: "ayanamislover/complete-implementation",
          worktreeRoot: "R:/Project_All/ATM",
        },
      },
    ],
  );
  queryClient.setQueryData(
    ["project-updates", "ATM"],
    [
      {
        status: "PUBLISHED",
        summary: "UI 模块化按计划推进",
        health: "ON_TRACK",
        publishedAt: "2026-08-28T01:00:00.000Z",
      },
    ],
  );
  queryClient.setQueryData(["reconciliation", "ATM"], {
    attentionCount: 1,
    items: [
      {
        taskKey: "ATM-T-0261",
        title: "提取 Project Summary",
        classification: "STALLED",
        ageSeconds: 3600,
        session: null,
        evidencePaths: ["packages/ui/src/features/project-summary.tsx"],
        suggestedAction: "检查最新进度",
      },
    ],
  });
  const workItems = [
    {
      id: "in-progress",
      key: "ATM-T-0261",
      title: "提取 Project Summary",
      status: "IN_PROGRESS",
      progress: 64,
      claimedBySessionId: "session-1",
    },
    { id: "ready", key: "ATM-T-0262", title: "提取任务视图", status: "READY", priority: "HIGH" },
    {
      id: "blocked",
      key: "ATM-T-0263",
      title: "提取 Task Drawer",
      status: "BLOCKED",
      blockedReason: "等待上游",
    },
  ];
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ProjectSummary, {
        client: client(),
        projectCode: "ATM",
        workItems,
        notify: vi.fn(),
        openTask: vi.fn(),
      }),
    ),
  );
}

function projectFeatureSource() {
  return `${readFileSync(summaryPath, "utf8")}\n${readFileSync(reconcilePath, "utf8")}`;
}

function missingProjectContracts(source: string): string[] {
  const contracts = [
    'queryKey: ["brief", projectCode]',
    'queryKey: ["overview"]',
    'queryKey: ["agents", projectCode]',
    'queryKey: ["project-updates", projectCode]',
    'queryKey: ["reconciliation", projectCode]',
    "useState(true)",
    "<ProjectProjectionPanel",
    "<EngineeringMetricsPanel",
    'aria-label="项目管理摘要"',
    'aria-label="任务对账"',
    'aria-label={collapsed ? "展开任务对账" : "折叠任务对账"}',
  ];
  return contracts.filter((contract) => !source.includes(contract));
}

describe("Project summary feature", () => {
  it("保持项目指标、管理卡、Projection、Reconcile 与 Metrics DOM", () => {
    const markup = renderSummary();

    for (const text of [
      "当前目标",
      "完成稳定版",
      "当前里程碑",
      "UI 模块化",
      "项目进度",
      "64%",
      "当前进行",
      "阻塞与等待",
      "Agent 与领取",
      "Codex UI",
      "最近项目更新",
      "UI 模块化按计划推进",
      "数据投影",
      "工程统计",
      "需对账 1 项",
    ]) {
      expect(markup).toContain(text);
    }
    expect(markup).toContain('aria-label="项目管理摘要"');
    expect(markup).toContain('aria-label="任务对账"');
    expect(markup).toContain('aria-label="工程统计"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('id="engineering-metrics-content" hidden=""');
  });

  it("保持摘要/Reconcile 查询、Projection/Metrics 组合与模块边界", () => {
    const source = projectFeatureSource();
    expect(missingProjectContracts(source)).toEqual([]);
    expect(source).not.toMatch(/from\s+["']\.\.\/app\.js["']/u);
    expect(readFileSync(summaryPath, "utf8").split(/\r?\n/u).length).toBeLessThan(600);
    expect(readFileSync(reconcilePath, "utf8").split(/\r?\n/u).length).toBeLessThan(600);
  });

  it("关键项目摘要契约有阳性变异红灯", () => {
    const source = projectFeatureSource();
    for (const contract of [
      'queryKey: ["overview"]',
      'queryKey: ["reconciliation", projectCode]',
      "useState(true)",
      "<ProjectProjectionPanel",
      "<EngineeringMetricsPanel",
    ]) {
      expect(missingProjectContracts(source.replaceAll(contract, "MUTATED"))).toContain(contract);
    }
  });
});

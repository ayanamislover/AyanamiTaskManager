import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AyanamiClient } from "@ayanami-task/client";
import { describe, expect, it, vi } from "vitest";
import { TaskDrawer } from "../src/features/task-drawer.js";

const drawerPath = join(process.cwd(), "packages", "ui", "src", "features", "task-drawer.tsx");

function client(): AyanamiClient {
  return {
    tasks: {
      get: vi.fn(),
      getForUi: vi.fn(),
      patchAsUser: vi.fn(),
      checklistAsUser: vi.fn(),
    },
    projects: { engineeringMetrics: vi.fn(), agentPage: vi.fn() },
  } as unknown as AyanamiClient;
}

function renderDrawer() {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["task", "ATM", "ATM-T-0263", "full"], {
    id: "task-263",
    key: "ATM-T-0263",
    title: "提取 TaskDrawer",
    description: "保持任务详情与操作行为等价",
    status: "READY",
    phase: "READY",
    version: 3,
    progress: 40,
    reportedProgress: 50,
    progressSource: "REPORTED",
    blockedReason: null,
    waitingFor: null,
    assigneeAgentId: null,
    claimLeaseUntil: null,
    acceptance: ["详情与检查项行为等价"],
    checklist: [
      {
        id: "check-1",
        version: 1,
        title: "附带证据",
        status: "TODO",
        evidenceRequired: true,
        evidence: ["focused 通过"],
        weight: 1,
      },
    ],
    relations: [
      { type: "PARENT", direction: "OUTGOING", taskKey: "ATM-T-0250" },
      { type: "DISCOVERED_FROM", direction: "OUTGOING", taskKey: "ATM-T-0248" },
    ],
  });
  queryClient.setQueryData(["engineering-metrics", "ATM", "ATM-T-0263"], {
    available: true,
    workItem: {
      metrics: {
        filesChanged: 2,
        filesCreated: 1,
        filesDeleted: 0,
        linesAdded: 120,
        linesDeleted: 20,
        netLines: 100,
        sourceLinesAdded: 80,
        testLinesAdded: 40,
        dependenciesAdded: [],
      },
    },
  });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(TaskDrawer, {
        client: client(),
        project: "ATM",
        taskKey: "ATM-T-0263",
        close: vi.fn(),
        notify: vi.fn(),
      }),
    ),
  );
}

function missingDrawerContracts(source: string): string[] {
  const contracts = [
    'queryKey: ["task", project, taskKey, "full"]',
    'client.tasks.get(project, taskKey, "full")',
    "client.tasks.getForUi(project, taskKey)",
    'queryKey: ["engineering-metrics", project, taskKey]',
    'queryKey: ["tasks", project]',
    'queryKey: ["reconciliation", project]',
    'queryKey: ["brief", project]',
    'queryKey: ["overview"]',
    "client.tasks.patchAsUser",
    "client.tasks.checklistAsUser",
    "workItemUiActions",
    "checklistToggleIntent",
    "evidenceText",
    "useDialogAccessibility(close)",
    'aria-label="收起任务详情"',
    'className="atm-drawer"',
  ];
  return contracts.filter((contract) => !source.includes(contract));
}

describe("TaskDrawer feature", () => {
  it("保持详情、操作、checklist/evidence、关系与工程变更 DOM", () => {
    const markup = renderDrawer();
    for (const text of [
      "提取 TaskDrawer",
      "保持任务详情与操作行为等价",
      "开始",
      "取消",
      "派生 40%",
      "Agent 报告：50%",
      "执行 Session",
      "详情与检查项行为等价",
      "附带证据",
      "focused 通过",
      "添加证据",
      "跳过",
      "父任务 ATM-T-0250",
      "发现于 ATM-T-0248",
      "工程变更",
      "+120",
    ]) {
      expect(markup).toContain(text);
    }
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-label="任务详情"');
    expect(markup).toContain('aria-label="收起任务详情"');
    expect(markup).not.toContain('aria-label="关闭"');
  });

  it("保持 query/mutation/invalidation 与对话框可访问性契约", () => {
    const source = readFileSync(drawerPath, "utf8");
    expect(missingDrawerContracts(source)).toEqual([]);
    expect(source).not.toMatch(/from\s+["']\.\.\/app\.js["']/u);
    expect(source.split(/\r?\n/u).length).toBeLessThan(600);
  });

  it("关键 Drawer 契约逐项变异时守卫验红", () => {
    const source = readFileSync(drawerPath, "utf8");
    for (const contract of [
      'queryKey: ["task", project, taskKey, "full"]',
      "client.tasks.patchAsUser",
      "client.tasks.checklistAsUser",
      "useDialogAccessibility(close)",
      'aria-label="收起任务详情"',
    ]) {
      expect(missingDrawerContracts(source.replaceAll(contract, "MUTATED"))).toContain(contract);
    }
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AyanamiClient, RegisteredProject } from "@ayanami-task/client";
import { describe, expect, it, vi } from "vitest";
import { ProjectPage } from "../src/features/project.js";

const projectPath = join(process.cwd(), "packages", "ui", "src", "features", "project.tsx");

function client(): AyanamiClient {
  return {
    tasks: { pageForUi: vi.fn() },
    projects: {
      recordPage: vi.fn(),
      archive: vi.fn(),
      restore: vi.fn(),
      trash: vi.fn(),
      brief: vi.fn(),
      agents: vi.fn(),
      updates: vi.fn(),
      reconciliation: vi.fn(),
      milestones: vi.fn(),
      engineeringMetrics: vi.fn(),
    },
    overview: vi.fn(),
    events: vi.fn(),
    savedViews: { list: vi.fn(), create: vi.fn(), remove: vi.fn() },
  } as unknown as AyanamiClient;
}

function renderProject() {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["overview"], { projects: [] });
  queryClient.setQueryData(["brief", "ATM"], {});
  queryClient.setQueryData(["agents", "ATM"], []);
  queryClient.setQueryData(["project-updates", "ATM"], []);
  queryClient.setQueryData(["reconciliation", "ATM"], { attentionCount: 0, items: [] });
  queryClient.setQueryData(["saved-views", "ATM"], []);
  queryClient.setQueryData(["milestones", "ATM"], []);
  const project = {
    code: "ATM",
    name: "AyanamiTaskManager 自举验收",
    description: "本地优先任务管理",
    lifecycle: "ACTIVE",
  } as unknown as RegisteredProject;
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ProjectPage, {
        client: client(),
        project,
        notify: vi.fn(),
        openTask: vi.fn(),
        onExit: vi.fn(),
      }),
    ),
  );
}

function missingProjectContracts(source: string): string[] {
  const contracts = [
    'useCursorCollection(["tasks", project.code, "ui"]',
    "client.tasks.pageForUi(project.code",
    'queryKey: ["events", project.code]',
    'enabled: view === "timeline"',
    '["records", project.code]',
    "client.projects.recordPage(project.code, 100, cursor)",
    'view === "records"',
    "useProjectTaskViewState(tasks.items)",
    "client.projects.restore(project.code)",
    "client.projects.archive(project.code)",
    "client.projects.trash(project.code)",
    'queryKey: ["projects"]',
    'queryKey: ["overview"]',
    "queryClient.invalidateQueries()",
    'window.addEventListener("atm:new-project-task", listener)',
    "<ProjectSummary",
    "<ProjectTaskControls",
    "<ProjectTaskViews",
    "<CreateTaskModal",
    "<CreateRecordModal",
    "<ProjectUpdateModal",
    "<ProjectDataModal",
  ];
  return contracts.filter((contract) => !source.includes(contract));
}

describe("ProjectPage orchestrator feature", () => {
  it("保持项目页头、管理动作、任务与记录入口 DOM", () => {
    const markup = renderProject();
    for (const text of [
      "AyanamiTaskManager 自举验收",
      "本地优先任务管理",
      "发布项目更新",
      "数据工具",
      "启动 Agent 会话",
      "归档项目",
      "新建任务",
      "当前目标",
      "保存视图",
      "列表",
      "看板",
      "时间线",
      "层级",
      "记录",
    ]) {
      expect(markup).toContain(text);
    }
  });

  it("保持查询、游标、enabled、invalidation、路由与 slot 编排契约", () => {
    const source = readFileSync(projectPath, "utf8");
    expect(missingProjectContracts(source)).toEqual([]);
    expect(source).not.toMatch(/from\s+["']\.\.\/app\.js["']/u);
    expect(source).not.toMatch(/from\s+["']\.\.\/index\.js["']/u);
    expect(source.split(/\r?\n/u).length).toBeLessThan(600);
  });

  it("关键 Project 编排契约逐项变异时守卫验红", () => {
    const source = readFileSync(projectPath, "utf8");
    for (const contract of [
      'queryKey: ["events", project.code]',
      'enabled: view === "timeline"',
      "client.projects.recordPage(project.code, 100, cursor)",
      "useProjectTaskViewState(tasks.items)",
      "client.projects.trash(project.code)",
      'window.addEventListener("atm:new-project-task", listener)',
      "<ProjectTaskViews",
      "<ProjectDataModal",
    ]) {
      expect(missingProjectContracts(source.replaceAll(contract, "MUTATED"))).toContain(contract);
    }
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AyanamiClient } from "@ayanami-task/client";
import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_PROJECT_TASK_FILTERS,
  ProjectTaskControls,
  filterProjectTasks,
} from "../src/features/project-task-controls.js";
import { ProjectTaskViews } from "../src/features/project-task-views.js";

const controlsPath = join(
  process.cwd(),
  "packages",
  "ui",
  "src",
  "features",
  "project-task-controls.tsx",
);
const viewsPath = join(
  process.cwd(),
  "packages",
  "ui",
  "src",
  "features",
  "project-task-views.tsx",
);

const tasks = [
  {
    id: "ready",
    key: "ATM-T-1",
    title: "高优先级任务",
    status: "READY",
    priority: "HIGH",
    assigneeAgentId: "Codex",
    milestoneId: "m-1",
    targetDate: "2026-08-27",
    progressSource: "REPORTED",
    updatedAt: "2026-08-28T01:00:00.000Z",
    progress: 20,
    parentId: null,
  },
  {
    id: "done",
    key: "ATM-T-2",
    title: "已完成任务",
    status: "DONE",
    priority: "LOW",
    assigneeAgentId: "USER",
    milestoneId: null,
    targetDate: "2026-08-20",
    progressSource: "COMPUTED",
    updatedAt: "2026-08-28T02:00:00.000Z",
    progress: 100,
    parentId: null,
  },
];

function client(): AyanamiClient {
  return {
    savedViews: { list: vi.fn(), create: vi.fn(), remove: vi.fn() },
    projects: { milestones: vi.fn() },
  } as unknown as AyanamiClient;
}

function renderControls() {
  const queryClient = new QueryClient();
  queryClient.setQueryData(
    ["saved-views", "ATM"],
    [{ id: "view-1", version: 1, name: "我的视图", query: { status: "READY" } }],
  );
  queryClient.setQueryData(["milestones", "ATM"], [{ id: "m-1", title: "UI 模块化" }]);
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ProjectTaskControls, {
        client: client(),
        project: "ATM",
        tasks,
        view: "list",
        onViewChange: vi.fn(),
        filters: EMPTY_PROJECT_TASK_FILTERS,
        onFiltersChange: vi.fn(),
        notify: vi.fn(),
      }),
    ),
  );
}

function collection(items: unknown[]) {
  return {
    items,
    loadedCount: items.length,
    hasMore: false,
    isLoading: false,
    isFetchingNextPage: false,
    error: null,
    retry: vi.fn(),
  };
}

describe("Project task controls and five views", () => {
  it("保持五视图 tab、自绘筛选与保存视图 DOM", () => {
    const markup = renderControls();
    for (const text of [
      "列表",
      "看板",
      "时间线",
      "层级",
      "记录",
      "保存视图",
      "全部状态",
      "全部负责人",
      "全部里程碑",
      "全部日期",
      "全部进度来源",
      "仅阻塞",
      "保存当前",
    ]) {
      expect(markup).toContain(text);
    }
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('role="combobox"');
    expect(markup).not.toContain("<select");
  });

  it("保持筛选条件的组合与逾期完成项排除语义", () => {
    expect(filterProjectTasks(tasks, { ...EMPTY_PROJECT_TASK_FILTERS, status: "READY" })).toEqual([
      tasks[0],
    ]);
    expect(
      filterProjectTasks(tasks, {
        ...EMPTY_PROJECT_TASK_FILTERS,
        assignee: "Codex",
        milestone: "m-1",
        due: "OVERDUE",
        progressSource: "REPORTED",
      }),
    ).toEqual([tasks[0]]);
    expect(
      filterProjectTasks(tasks, { ...EMPTY_PROJECT_TASK_FILTERS, due: "OVERDUE" }),
    ).not.toContain(tasks[1]);
  });

  it("保持 list/board/timeline/tree/records 的关键 DOM 与空态", () => {
    const common = {
      tasks: collection(tasks),
      records: collection([]),
      events: { isLoading: false, data: { events: [] } },
      filteredTasks: tasks,
      sortedTasks: tasks,
      taskSort: null,
      onTaskSort: vi.fn(),
      onOpenTask: vi.fn(),
    };
    const renderView = (view: "list" | "board" | "timeline" | "tree" | "records") =>
      renderToStaticMarkup(createElement(ProjectTaskViews, { ...common, view }));

    expect(renderView("list")).toContain('class="atm-table"');
    expect(renderView("list")).toContain('aria-label="按任务排序"');
    expect(renderView("list")).toContain('aria-label="按优先级排序"');
    expect(renderView("board")).toContain('class="atm-board"');
    expect(renderView("tree")).toContain('class="atm-tree"');
    expect(renderView("timeline")).toContain("没有项目事件");
    expect(renderView("records")).toContain("还没有项目记录");
  });

  it("模块边界保留 query/keyset/排序契约并限制文件深度", () => {
    const controls = readFileSync(controlsPath, "utf8");
    const views = readFileSync(viewsPath, "utf8");
    for (const contract of [
      '["saved-views", project]',
      '["milestones", project]',
      "toggleProjectTaskSort",
      "sortProjectTasks",
      "EMPTY_PROJECT_TASK_FILTERS",
    ]) {
      expect(controls).toContain(contract);
    }
    for (const contract of [
      "<CursorLoadStatus",
      "records.hasMore",
      "records.retry()",
      "events.data?.events",
      "<TimelineEventRow",
      '<table className="atm-table">',
    ]) {
      expect(views).toContain(contract);
    }
    expect(controls).not.toMatch(/from\s+["']\.\.\/app\.js["']/u);
    expect(views).not.toMatch(/from\s+["']\.\.\/app\.js["']/u);
    expect(controls.split(/\r?\n/u).length).toBeLessThan(600);
    expect(views.split(/\r?\n/u).length).toBeLessThan(600);
  });
});

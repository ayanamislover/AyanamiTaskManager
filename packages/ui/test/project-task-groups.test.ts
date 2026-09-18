import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_PROJECT_TASK_FILTERS,
  projectTaskGroups,
} from "../src/features/project-task-controls.js";
import { ProjectTaskViews } from "../src/features/project-task-views.js";

// 任务列表默认只有未结束任务和最近结束的几项。已结束任务单独成组放在表尾，
// 保持「最近结束在前」，不参与表头排序。

const task = (key: string, status: string, priority = "NORMAL", localNo = Number(key.at(-1))) => ({
  id: key,
  key,
  localNo,
  title: `任务 ${key}`,
  status,
  priority,
  updatedAt: "2026-09-17T00:00:00.000Z",
});

const open = [task("P-T-1", "READY", "LOW"), task("P-T-2", "IN_PROGRESS", "CRITICAL")];
// 服务端给的顺序：最近结束的在前。
const closed = [task("P-T-3", "DONE"), task("P-T-5", "CANCELLED"), task("P-T-4", "DONE")];

describe("项目任务分组", () => {
  it("表头排序只作用于未结束任务，已结束任务保持最近结束在前", () => {
    const groups = projectTaskGroups(open, closed, EMPTY_PROJECT_TASK_FILTERS, {
      field: "task",
      direction: "asc",
    });
    expect(groups.sortedTasks.map((row) => row.key)).toEqual(["P-T-1", "P-T-2"]);
    expect(groups.closedRows.map((row) => row.key)).toEqual(["P-T-3", "P-T-5", "P-T-4"]);
  });

  it("两次读取之间刚结束的任务只出现一次，以已结束那边为准", () => {
    const racing = [...open, task("P-T-3", "IN_PROGRESS")];
    const groups = projectTaskGroups(racing, closed, EMPTY_PROJECT_TASK_FILTERS, {
      field: "task",
      direction: "desc",
    });
    expect(groups.allTasks.filter((row) => row.key === "P-T-3")).toHaveLength(1);
    expect(groups.sortedTasks.map((row) => row.key)).not.toContain("P-T-3");
    expect(groups.closedRows.map((row) => row.key)).toContain("P-T-3");
  });

  it("筛选同时作用于两组", () => {
    const groups = projectTaskGroups(
      open,
      closed,
      { ...EMPTY_PROJECT_TASK_FILTERS, status: "DONE" },
      { field: "task", direction: "desc" },
    );
    expect(groups.sortedTasks).toEqual([]);
    expect(groups.closedRows.map((row) => row.key)).toEqual(["P-T-3", "P-T-4"]);
  });

  it("列表视图把已结束任务渲染在单独的分组里并显示已加载比例", () => {
    const groups = projectTaskGroups(open, closed, EMPTY_PROJECT_TASK_FILTERS, {
      field: "task",
      direction: "desc",
    });
    const collection = (items: unknown[]) => ({
      items,
      loadedCount: items.length,
      hasMore: false,
      isLoading: false,
      isFetchingNextPage: false,
      error: null,
      retry: vi.fn(),
    });
    const markup = renderToStaticMarkup(
      createElement(ProjectTaskViews, {
        view: "list",
        tasks: collection(open),
        records: collection([]),
        events: { isLoading: false, data: { events: [] } },
        filteredTasks: groups.filteredTasks,
        sortedTasks: groups.sortedTasks,
        closedRows: groups.closedRows,
        closedTasks: {
          items: closed,
          total: 40,
          hasMore: true,
          isLoading: false,
          isFetchingMore: false,
          error: null,
          loadMore: vi.fn(),
        },
        taskSort: null,
        onTaskSort: vi.fn(),
        onOpenTask: vi.fn(),
      }),
    );
    const closedGroup = markup.slice(markup.indexOf('class="atm-closed-tasks"'));
    expect(closedGroup).toContain("最近结束");
    expect(closedGroup).toContain("显示 3 / 40 项");
    for (const key of ["P-T-3", "P-T-4", "P-T-5"]) expect(closedGroup).toContain(key);
    expect(closedGroup).not.toContain("P-T-1");
    expect(markup).toContain("还有 37 项已结束任务未加载");
    expect(markup).toContain("加载更多已结束任务");
    // 全部读完且没出错时，不再显示「已加载 N 项，已全部加载」。
    expect(markup).not.toContain("已全部加载");
  });
});

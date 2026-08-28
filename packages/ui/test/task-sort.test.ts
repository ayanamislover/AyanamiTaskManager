import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROJECT_TASK_SORT,
  sortProjectTasks,
  toggleProjectTaskSort,
} from "../src/task-sort.js";

const tasks = [
  {
    id: "normal",
    key: "ATM-T-9",
    localNo: 9,
    priority: "NORMAL",
    status: "READY",
    updatedAt: "2026-08-08T09:00:00Z",
  },
  {
    id: "critical",
    key: "ATM-T-10",
    localNo: 10,
    priority: "CRITICAL",
    status: "VERIFYING",
    updatedAt: "2026-08-08T08:00:00Z",
  },
  {
    id: "high",
    key: "ATM-T-8",
    localNo: 8,
    priority: "HIGH",
    status: "IN_PROGRESS",
    updatedAt: "2026-08-08T10:00:00Z",
  },
];

describe("项目任务单字段排序", () => {
  it("默认按任务编号倒序", () => {
    expect(DEFAULT_PROJECT_TASK_SORT).toEqual({ field: "task", direction: "desc" });
    expect(sortProjectTasks(tasks, DEFAULT_PROJECT_TASK_SORT).map((task) => task.id)).toEqual([
      "critical",
      "normal",
      "high",
    ]);
  });

  it("旧任务缺少 localNo 时从任务键末尾解析编号", () => {
    const legacy = [
      { id: "older", key: "ATM-T-0007" },
      { id: "newer", key: "ATM-T-0012" },
    ];
    expect(sortProjectTasks(legacy, DEFAULT_PROJECT_TASK_SORT).map((task) => task.id)).toEqual([
      "newer",
      "older",
    ]);
  });

  it("首次点击默认降序，再次点击同字段切换为升序", () => {
    const descending = toggleProjectTaskSort(null, "priority");
    expect(descending).toEqual({ field: "priority", direction: "desc" });
    expect(toggleProjectTaskSort(descending, "priority")).toEqual({
      field: "priority",
      direction: "asc",
    });
  });

  it("切换字段时替换旧字段，始终只有一个排序条件", () => {
    expect(toggleProjectTaskSort({ field: "priority", direction: "asc" }, "updatedAt")).toEqual({
      field: "updatedAt",
      direction: "desc",
    });
  });

  it("按优先级、状态工作流和更新时间稳定排序", () => {
    expect(
      sortProjectTasks(tasks, { field: "priority", direction: "desc" }).map((task) => task.id),
    ).toEqual(["critical", "high", "normal"]);
    expect(
      sortProjectTasks(tasks, { field: "status", direction: "asc" }).map((task) => task.id),
    ).toEqual(["normal", "high", "critical"]);
    expect(
      sortProjectTasks(tasks, { field: "updatedAt", direction: "desc" }).map((task) => task.id),
    ).toEqual(["high", "normal", "critical"]);
  });
});

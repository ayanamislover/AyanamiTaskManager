import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AyanamiClient } from "@ayanami-task/client";
import { describe, expect, it, vi } from "vitest";
import {
  nextRovingIndex,
  taskRowInteractionProps,
} from "../src/components/keyboard-interactions.js";
import { ProjectTaskControls } from "../src/features/project-task-controls.js";
import { ProjectTaskViews } from "../src/features/project-task-views.js";
import { NotificationPolicy } from "../src/features/settings-panels.js";

function renderControls() {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["saved-views", "ATM"], []);
  queryClient.setQueryData(["milestones", "ATM"], []);
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ProjectTaskControls, {
        client: { savedViews: {}, projects: {} } as unknown as AyanamiClient,
        project: "ATM",
        tasks: [],
        view: "timeline",
        onViewChange: vi.fn(),
        filters: {
          status: "",
          assignee: "",
          milestone: "",
          due: "",
          blockedOnly: false,
          progressSource: "",
        },
        onFiltersChange: vi.fn(),
        notify: vi.fn(),
      }),
    ),
  );
}

function renderViews() {
  const collection = {
    items: [],
    loadedCount: 0,
    hasMore: false,
    isLoading: false,
    isFetchingNextPage: false,
    error: null,
    retry: vi.fn(),
  };
  return renderToStaticMarkup(
    createElement(ProjectTaskViews, {
      view: "timeline",
      tasks: collection as never,
      records: collection as never,
      events: { isLoading: false, data: { events: [] } },
      filteredTasks: [],
      sortedTasks: [],
      taskSort: null,
      onTaskSort: vi.fn(),
      onOpenTask: vi.fn(),
    }),
  );
}

describe("keyboard accessibility primitives", () => {
  it("两张任务表格都使用同一行交互合同，移除任一接入都会验红", () => {
    const sources = ["overview.tsx", "project-task-views.tsx"].map((name) =>
      readFileSync(join(process.cwd(), "packages", "ui", "src", "features", name), "utf8"),
    );
    const hasInteractiveTaskRow = (source: string) =>
      source.includes("...taskRowInteractionProps(") && source.includes("打开任务 ${task.key}");

    expect(sources.map(hasInteractiveTaskRow)).toEqual([true, true]);
    expect(hasInteractiveTaskRow(sources[0]!.replace("...taskRowInteractionProps(", ""))).toBe(
      false,
    );
  });

  it("跨项目任务表格原地打开 Drawer，避免路由卸载触发器破坏焦点恢复", () => {
    const source = readFileSync(join(process.cwd(), "packages", "ui", "src", "app.tsx"), "utf8");
    const inPlaceBindings = source.match(/onTask=\{openTaskInPlace\}/gu) ?? [];
    expect(source).toMatch(
      /const openTaskInPlace = \(project: string, key: string\) => setDrawer\(\{ project, key \}\)/u,
    );
    expect(inPlaceBindings).toHaveLength(2);
    expect(source.replace("onTask={openTaskInPlace}", "onTask={openTask}")).not.toMatch(
      /onTask=\{openTaskInPlace\}[\s\S]*onTask=\{openTaskInPlace\}/u,
    );
  });

  it("任务行焦点沿用现有设计 token，并由 forced-colors 保留系统指示", () => {
    const styles = readFileSync(join(process.cwd(), "packages", "ui", "src", "styles.css"), "utf8");
    const hasRowFocusGuard = (source: string) =>
      source.includes(".atm-table tbody tr[tabindex]:focus-visible") &&
      /@media \(forced-colors: active\)[\s\S]*?:focus-visible[\s\S]*?outline-color: Highlight/u.test(
        source,
      );
    expect(hasRowFocusGuard(styles)).toBe(true);
    expect(hasRowFocusGuard(styles.replace("tr[tabindex]:focus-visible", "tr"))).toBe(false);
  });

  it("Project 五 tabs 具备完整关联与单一 roving tab stop", () => {
    const markup = renderControls();
    expect(markup).toContain('role="tablist" aria-label="项目任务视图"');
    expect(markup.match(/role="tab"/gu)).toHaveLength(5);
    expect(markup.match(/aria-controls="project-task-panel"/gu)).toHaveLength(5);
    expect(markup.match(/tabindex="0"/gu)).toHaveLength(1);
    expect(markup).toContain('id="project-task-tab-timeline"');
    expect(markup).toContain('aria-selected="true"');
  });

  it("每个 tab 的 aria-controls 都解析到同一个已渲染 panel", () => {
    const controls = renderControls();
    const panel = renderViews();
    const referencedIds = [...controls.matchAll(/aria-controls="([^"]+)"/gu)].map(
      (match) => match[1]!,
    );
    const resolvesEveryControl = (panelMarkup: string) =>
      referencedIds.every((id) => panelMarkup.includes(`id="${id}"`));

    expect(referencedIds).toHaveLength(5);
    expect(new Set(referencedIds)).toEqual(new Set(["project-task-panel"]));
    expect(panel).toContain('id="project-task-panel"');
    expect(panel).toContain('aria-labelledby="project-task-tab-timeline"');
    expect(resolvesEveryControl(panel)).toBe(true);
    expect(resolvesEveryControl(panel.replace('id="project-task-panel"', 'id="missing"'))).toBe(
      false,
    );
  });

  it("通知 radio 具备 radiogroup 与单一 roving tab stop", () => {
    const markup = renderToStaticMarkup(
      createElement(NotificationPolicy, { value: "CRITICAL", onChange: vi.fn() }),
    );
    expect(markup).toContain('role="radiogroup" aria-label="系统通知级别"');
    expect(markup.match(/role="radio"/gu)).toHaveLength(3);
    expect(markup.match(/tabindex="0"/gu)).toHaveLength(1);
    expect(markup).toContain('aria-checked="true" tabindex="0"');
  });

  it("Arrow/Home/End 计算首尾循环，方向约束明确", () => {
    expect(nextRovingIndex("ArrowRight", 4, 5)).toBe(0);
    expect(nextRovingIndex("ArrowLeft", 0, 5)).toBe(4);
    expect(nextRovingIndex("Home", 3, 5)).toBe(0);
    expect(nextRovingIndex("End", 1, 5)).toBe(4);
    expect(nextRovingIndex("ArrowDown", 1, 3, true)).toBe(2);
    expect(nextRovingIndex("ArrowUp", 0, 3, true)).toBe(2);
    expect(nextRovingIndex("ArrowDown", 1, 3)).toBeNull();
  });

  it("任务表格行的鼠标、Enter 与 Space 都聚焦同一触发器并打开", () => {
    const open = vi.fn();
    const focus = vi.fn();
    const preventDefault = vi.fn();
    const props = taskRowInteractionProps("打开任务 ATM-T-0252", open);
    expect(props.tabIndex).toBe(0);
    expect(props["aria-haspopup"]).toBe("dialog");
    expect(props["aria-label"]).toBe("打开任务 ATM-T-0252");

    props.onClick({ currentTarget: { focus } } as never);
    props.onKeyDown({ key: "Enter", currentTarget: { focus }, preventDefault } as never);
    props.onKeyDown({ key: " ", currentTarget: { focus }, preventDefault } as never);
    expect(open).toHaveBeenCalledTimes(3);
    expect(focus).toHaveBeenCalledTimes(3);
    expect(preventDefault).toHaveBeenCalledTimes(2);
  });
});
import { readFileSync } from "node:fs";
import { join } from "node:path";

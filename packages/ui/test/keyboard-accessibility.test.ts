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
import { uiCssText } from "./css-source-graph.js";

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
    const app = readFileSync(join(process.cwd(), "packages", "ui", "src", "app.tsx"), "utf8");
    const router = readFileSync(
      join(process.cwd(), "packages", "ui", "src", "routes", "app-router.tsx"),
      "utf8",
    );
    const inPlaceBindings = (source: string) => (source.match(/onTask=\{onTask\}/gu) ?? []).length;
    expect(app).toMatch(
      /const openTaskInPlace = \(project: string, key: string\) => setDrawer\(\{ project, key \}\)/u,
    );
    expect(app).toContain("onTask={openTaskInPlace}");
    // 总览「等你处理」、活动任务、阻塞与等待三处都原地打开抽屉。
    expect(inPlaceBindings(router)).toBe(3);
    expect(inPlaceBindings(router.replace("onTask={onTask}", "onTask={() => undefined}"))).not.toBe(
      3,
    );
  });

  it("任务行焦点沿用现有设计 token，并由 forced-colors 保留系统指示", () => {
    const styles = uiCssText();
    // 绑定到任务行实际依赖的那一条：forced-colors 里的通用 `:focus-visible { outline-color: Highlight; }`。
    // 不能写成「块里某处有 :focus-visible、某处有 Highlight」——别的组件的 Highlight 规则也会让它通过。
    const genericForcedFocus =
      /@media \(forced-colors: active\) \{[^@]*?\n {2}:focus-visible \{\s*outline-color: Highlight;\s*\}/u;
    const hasRowFocusGuard = (source: string) =>
      source.includes(".atm-table tbody tr[tabindex]:focus-visible") &&
      genericForcedFocus.test(source);
    expect(hasRowFocusGuard(styles)).toBe(true);
    // 行焦点现在有两条规则（整行 outline 与单元格底色），变异要把两条都拿掉。
    expect(hasRowFocusGuard(styles.replaceAll("tr[tabindex]:focus-visible", "tr"))).toBe(false);
    // 只把通用那条改掉、保留抽屉专用的 Highlight：必须仍然发现。
    const genericOnlyMutated = styles.replace(
      /(\n {2}:focus-visible \{\s*outline-color: )Highlight;/u,
      "$1Canvas;",
    );
    expect(genericOnlyMutated).not.toBe(styles);
    expect(genericOnlyMutated).toContain(".atm-drawer-collapse:focus-visible > svg");
    expect(hasRowFocusGuard(genericOnlyMutated)).toBe(false);
    expect(
      hasRowFocusGuard(
        ".atm-table tbody tr { outline: none; } @media (forced-colors: active) { :focus-visible { outline-color: Canvas; } }",
      ),
    ).toBe(false);
  });

  it("抽屉收起把手在 forced-colors 下用系统高亮色画焦点环", () => {
    const styles = uiCssText();
    const drawerForcedFocus =
      /@media \(forced-colors: active\) \{[^@]*?\.atm-drawer-collapse:focus-visible > svg \{\s*outline-color: Highlight;/u;
    expect(styles).toMatch(drawerForcedFocus);
    expect(
      styles.replace(
        /(\.atm-drawer-collapse:focus-visible > svg \{\s*outline-color: )Highlight;/u,
        "$1Canvas;",
      ),
    ).not.toMatch(drawerForcedFocus);
  });

  it("进度条填充在 forced-colors 下换成系统高亮色，不随渐变一起消失", () => {
    const styles = uiCssText();
    const forcedProgress =
      /@media \(forced-colors: active\) \{[^@]*?\.atm-progress > span \{\s*background: Highlight;/u;
    expect(styles).toMatch(forcedProgress);
    expect(
      styles.replace(/(\.atm-progress > span \{\s*background: )Highlight;/u, "$1Canvas;"),
    ).not.toMatch(forcedProgress);
  });

  it("窄屏侧栏收起时藏的是字标，logo 留着", () => {
    // 收起侧栏的是把 --atm-sidebar 压到 68px 的那一段。
    const narrow =
      [...uiCssText().matchAll(/@media \(max-width: 760px\) \{([\s\S]*?)\n\}/gu)]
        .map((match) => match[1]!)
        .find((block) => block.includes("--atm-sidebar: 68px")) ?? "";
    expect(narrow).toContain(".atm-brand .atm-wordmark");
    expect(narrow).not.toMatch(/\.atm-brand span\b/u);
    // 「工作区」折叠按钮的字和状态灯的「正常」两个字，68px 里都放不下。
    expect(narrow).toMatch(/\.atm-nav-disclosure span \{\s*display: none;/u);
    expect(narrow).toMatch(/\.atm-service-status \{[^}]*font-size: 0;/u);
  });

  it("forced-colors 用等特指度规则恢复自绘 Select 的系统焦点环", () => {
    const styles = uiCssText();
    const forcedColorsSelect =
      /@media \(forced-colors: active\)[\s\S]*?\.atm-field-shell > \.atm-select-trigger:is\(:focus-visible\):not\(:disabled\)\s*\{[\s\S]*?outline:\s*2px solid Highlight;/u;
    expect(styles).toMatch(forcedColorsSelect);
    expect(
      styles.replace(
        ".atm-field-shell > .atm-select-trigger:is(:focus-visible):not(:disabled) {",
        ".atm-field-shell > .atm-select-trigger:focus-visible {",
      ),
    ).not.toMatch(forcedColorsSelect);
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

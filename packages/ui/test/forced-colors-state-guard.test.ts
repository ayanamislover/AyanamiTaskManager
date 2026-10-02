import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AyanamiClient, RegisteredProject } from "@ayanami-task/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProjectTaskControls,
  ProjectTaskSortHeader,
} from "../src/features/project-task-controls.js";
import { NotificationPolicy } from "../src/features/settings-panels.js";
import { Sidebar } from "../src/shell/sidebar.js";
import {
  element,
  forcedInvisibleViolations,
  forcedStateViolations,
  parseCssRules,
  parseMarkup,
  querySelector,
  querySelectorAll,
  type CascadeEnvironment,
  type ForcedStateCase,
  type ModelElement,
} from "./css-cascade-model.js";
import { uiCssSources } from "./css-source-graph.js";

/*
 * 桌面端：高对比度（forced-colors）下，选中 / 当前 / 禁用这些状态必须还看得出来。
 * forced-colors 会抹掉非系统色的底、渐变与投影；只靠它们表达的状态，两态会长得一模一样。
 * 组件尽量用真实渲染出的 markup，在 css-cascade-model 的级联模型里比较两态留得下来的外观，
 * 并检查系统色底上的字是否用了配对的前景色（Highlight 底配 HighlightText）。
 */

const DESKTOP_FORCED: CascadeEnvironment = {
  forcedColors: true,
  finePointer: true,
  viewportWidth: 1440,
};

type Source = { path: string; text: string };

function renderModel(node: ReactElement): ModelElement[] {
  return parseMarkup(renderToStaticMarkup(node));
}

function desktopDocument(...nodes: ModelElement[]): ModelElement {
  return element("html", { lang: "zh-CN", "data-theme": "light" }, [
    element("body", {}, [element("div", { id: "root" }, nodes)]),
  ]);
}

function first(root: ModelElement, selector: string): ModelElement {
  const [found] = querySelectorAll(root, selector);
  if (!found) throw new Error(`模型里找不到 ${selector}`);
  return found;
}

function renderTabs(): ModelElement[] {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["saved-views", "ATM"], []);
  queryClient.setQueryData(["milestones", "ATM"], []);
  return renderModel(
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

function renderSidebar(route: Parameters<typeof Sidebar>[0]["route"]): ModelElement {
  const projects = ["1", "2"].map(
    (id) => ({ id, code: `P${id}`, name: `项目 ${id}`, lifecycle: "ACTIVE" }) as RegisteredProject,
  );
  return desktopDocument(
    ...renderModel(createElement(Sidebar, { route, setRoute: vi.fn(), projects })),
  );
}

function sortHeader(active: boolean): ModelElement {
  return desktopDocument(
    element("table", { class: "atm-table" }, [
      element("thead", {}, [
        element(
          "tr",
          {},
          renderModel(
            createElement(ProjectTaskSortHeader, {
              field: "task",
              label: "任务",
              sort: active ? { field: "task", direction: "asc" } : null,
              onSort: vi.fn(),
            }),
          ),
        ),
      ]),
    ]),
  );
}

/** 知识库列表项：组件依赖后端查询，按 knowledge.tsx 的结构手写（结构由下面的用例绑定到源码）。 */
function knowledgeList(): ModelElement {
  const item = (selected: boolean) =>
    element(
      "button",
      { class: "atm-knowledge-list-item", type: "button", "data-selected": String(selected) },
      [
        element("span", { class: "atm-row-title" }, [], true),
        element("span", { class: "atm-row-sub" }, [], true),
        element("span", { class: "atm-knowledge-list-meta" }, [], true),
      ],
    );
  // 选中项夹在中间：最后一项没有分隔线（:last-child），放在末尾会多出一条和选中无关的差别。
  return desktopDocument(
    element("div", { class: "atm-knowledge-list" }, [item(false), item(true), item(false)]),
  );
}

/** 下拉弹层只在打开后渲染：按 atm-select.tsx 的结构手写，选中项带勾。 */
function selectPopover(): ModelElement {
  const option = (selected: boolean) =>
    element(
      "button",
      {
        type: "button",
        class: "atm-select-option",
        role: "option",
        "aria-selected": String(selected),
        "data-selected": String(selected),
      },
      [element("span", {}, [], true), ...(selected ? [element("svg", {})] : [])],
    );
  return desktopDocument(
    element("div", { class: "atm-select atm-field-shell", "data-open": "true" }, [
      element("div", { class: "atm-select-popover", role: "listbox" }, [
        option(true),
        option(false),
      ]),
    ]),
  );
}

function buttons(): ModelElement {
  const button = (className: string, disabled: boolean) =>
    element(
      "button",
      { type: "button", class: className, ...(disabled ? { disabled: "" } : {}) },
      [],
      true,
    );
  return desktopDocument(
    button("atm-button primary", false),
    button("atm-button primary", true),
    button("atm-button", false),
    button("atm-button", true),
  );
}

export function desktopStateCases(): ForcedStateCase[] {
  const tabs = desktopDocument(...renderTabs());
  const knowledgeRoute = renderSidebar("knowledge");
  const settingsRoute = renderSidebar("settings");
  const projectRoute = renderSidebar("project:P1");
  const notifications = desktopDocument(
    ...renderModel(createElement(NotificationPolicy, { value: "CRITICAL", onChange: vi.fn() })),
  );
  const knowledge = knowledgeList();
  const select = selectPopover();
  const actions = buttons();
  return [
    {
      label: "项目视图页签的当前页",
      on: querySelector(tabs, '[role="tab"][aria-selected="true"]'),
      off: first(tabs, '[role="tab"][aria-selected="false"]'),
    },
    {
      label: "侧栏导航的当前页",
      on: querySelector(knowledgeRoute, '.atm-nav button[aria-current="page"]'),
      off: first(knowledgeRoute, ".atm-nav-secondary button:not([aria-current])"),
    },
    {
      label: "侧栏设置的当前页",
      on: querySelector(settingsRoute, ".atm-sidebar-settings"),
      off: querySelector(knowledgeRoute, ".atm-sidebar-settings"),
    },
    {
      label: "侧栏项目的当前项",
      on: querySelector(projectRoute, '.atm-nav-project[aria-current="page"]'),
      off: first(projectRoute, ".atm-nav-project:not([aria-current])"),
    },
    {
      label: "知识库列表的选中项",
      on: querySelector(knowledge, '.atm-knowledge-list-item[data-selected="true"]'),
      off: first(knowledge, '.atm-knowledge-list-item[data-selected="false"]'),
    },
    {
      label: "系统通知的选中项",
      on: querySelector(notifications, '[role="radio"][aria-checked="true"]'),
      off: first(notifications, '[role="radio"][aria-checked="false"]'),
    },
    {
      label: "下拉弹层的选中项",
      on: querySelector(select, '.atm-select-option[data-selected="true"]'),
      off: querySelector(select, '.atm-select-option[data-selected="false"]'),
    },
    {
      label: "表头排序的当前列",
      on: querySelector(sortHeader(true), ".atm-table-sort"),
      off: querySelector(sortHeader(false), ".atm-table-sort"),
    },
    {
      label: "主按钮的可用与禁用",
      on: querySelector(actions, ".atm-button.primary:not([disabled])"),
      off: querySelector(actions, ".atm-button.primary[disabled]"),
    },
    {
      label: "普通按钮的可用与禁用",
      on: querySelector(actions, ".atm-button:not(.primary):not([disabled])"),
      off: querySelector(actions, ".atm-button:not(.primary)[disabled]"),
    },
  ];
}

function paintCases() {
  const progress = desktopDocument(
    element("div", { class: "atm-progress" }, [element("span", { style: "width: 40%" })]),
  );
  return [{ label: "进度条的填充", node: querySelector(progress, ".atm-progress > span") }];
}

export function desktopForcedViolations(sources: readonly Source[]): string[] {
  const rules = parseCssRules(sources);
  return [
    ...forcedStateViolations(rules, desktopStateCases(), DESKTOP_FORCED),
    ...forcedInvisibleViolations(rules, paintCases(), DESKTOP_FORCED),
  ];
}

function mutate(sources: readonly Source[], file: string, from: string, to: string): Source[] {
  let changed = false;
  const next = sources.map((source) => {
    if (!source.path.endsWith(file)) return source;
    const text = source.text.replace(from, to);
    changed ||= text !== source.text;
    return { ...source, text };
  });
  // 变异没落地，等于拿原样 CSS 去断言「会红」——静态守卫空转就是这个样子。
  if (!changed) throw new Error(`变异没有生效：${file} 里找不到\n${from}`);
  return next;
}

const SELECTED_RULE = [
  '  .atm-tabs button[aria-selected="true"],',
  '  .atm-nav button[aria-current="page"],',
  '  .atm-sidebar-settings[aria-current="page"],',
  '  .atm-knowledge-list-item[data-selected="true"] {',
  "    color: HighlightText;",
  "    background: Highlight;",
  "    box-shadow: none;",
  "    forced-color-adjust: none;",
  "  }",
].join("\n");
const SELECTED_CHILD_RULE = [
  "  :is(",
  '      .atm-tabs button[aria-selected="true"],',
  '      .atm-nav button[aria-current="page"],',
  '      .atm-sidebar-settings[aria-current="page"],',
  '      .atm-knowledge-list-item[data-selected="true"]',
  "    )",
  "    * {",
  "    color: HighlightText;",
  "  }",
].join("\n");

describe("forced-colors 下桌面端的状态看得出来", () => {
  // Sidebar 读 window.localStorage 决定「工作区」是否展开。
  beforeEach(() => {
    vi.stubGlobal("window", { localStorage: { getItem: vi.fn(() => null), setItem: vi.fn() } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("手写的模型对得上组件源码", () => {
    const source = (path: string) =>
      readFileSync(join(process.cwd(), "packages", "ui", "src", path), "utf8");
    const knowledge = source("features/knowledge.tsx");
    for (const fragment of [
      'className="atm-knowledge-list-item"',
      'data-selected={selectedId === hit.id ? "true" : "false"}',
      '<span className="atm-row-title">',
      '<span className="atm-row-sub">',
      '<span className="atm-knowledge-list-meta">',
    ]) {
      expect(knowledge).toContain(fragment);
    }
    const select = source("components/atm-select.tsx");
    expect(select).toContain('className="atm-select-option"');
    expect(select).toMatch(/option\.value === value \? <CheckCircle/u);
    expect(source("features/overview.tsx")).toMatch(
      /<div className="atm-progress">\s*<span style/u,
    );
  });

  it("选中、当前、禁用在 forced-colors 下两态可辨，系统高亮底上的字读得清，进度条填充画得出来", () => {
    expect(desktopForcedViolations(uiCssSources())).toEqual([]);
  });

  it("阳性对照：选中项回到只靠底色、高亮底上子元素字色没换、禁用不再降透明度、进度条不换系统色，都会红", () => {
    const sources = uiCssSources();
    const bareSelected = mutate(
      mutate(sources, "accessibility.css", SELECTED_RULE, ""),
      "accessibility.css",
      SELECTED_CHILD_RULE,
      "",
    );
    expect(desktopForcedViolations(bareSelected)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^项目视图页签的当前页：forced-colors 下两态看起来一样/u),
        expect.stringMatching(/^知识库列表的选中项：forced-colors 下两态看起来一样/u),
      ]),
    );
    // 侧栏导航的当前页原来还有加粗：去掉 Highlight 后仍可辨，但不该因此漏掉页签和知识库。
    const contrast = mutate(sources, "accessibility.css", SELECTED_CHILD_RULE, "");
    expect(desktopForcedViolations(contrast)).toEqual(
      expect.arrayContaining([
        '知识库列表的选中项（选中）：<span class="atm-row-sub"> 在 Highlight 底上用的是 var(--atm-text-muted)',
        expect.stringMatching(
          /^侧栏导航的当前页（选中）：<svg[^>]*> 在 Highlight 底上用的是 var\(--atm-primary\)$/u,
        ),
      ]),
    );
    // 没有 forced-color-adjust: none：浏览器在字后垫 Canvas 背板，HighlightText 的字成了一块白。
    const backplate = mutate(
      sources,
      "accessibility.css",
      SELECTED_RULE,
      SELECTED_RULE.replace("    forced-color-adjust: none;\n", ""),
    );
    expect(desktopForcedViolations(backplate)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^项目视图页签的当前页（选中）：<button[^>]*> 在 Canvas（文字背板）上用的是 HighlightText$/u,
        ),
        '知识库列表的选中项（选中）：<span class="atm-row-title"> 在 Canvas（文字背板）上用的是 HighlightText',
      ]),
    );
    const disabled = mutate(
      sources,
      "base.css",
      "button:disabled {\n  cursor: not-allowed;\n  opacity: 0.5;\n}",
      "button:disabled {\n  cursor: not-allowed;\n}",
    );
    expect(desktopForcedViolations(disabled)).toEqual([
      expect.stringMatching(/^主按钮的可用与禁用：forced-colors 下两态看起来一样/u),
      expect.stringMatching(/^普通按钮的可用与禁用：forced-colors 下两态看起来一样/u),
    ]);
    const progress = mutate(
      sources,
      "features-primary.css",
      "  .atm-progress > span {\n    background: Highlight;\n    forced-color-adjust: none;\n  }",
      "",
    );
    expect(desktopForcedViolations(progress)).toEqual([
      expect.stringMatching(/^进度条的填充：forced-colors 下什么都画不出来/u),
    ]);
  });
});

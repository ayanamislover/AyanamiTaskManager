import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RegisteredProject } from "@ayanami-task/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../src/shell/app-shell.js";

const sourcePath = join(process.cwd(), "packages", "ui", "src", "shell", "app-shell.tsx");

function project(): RegisteredProject {
  return {
    id: "project-id",
    code: "ATM",
    name: "AyanamiTaskManager",
    lifecycle: "ACTIVE",
  } as RegisteredProject;
}

function renderShell({
  route = "overview",
  theme = "light",
}: {
  route?: "overview" | `project:${string}`;
  theme?: "light" | "dark";
} = {}): string {
  return renderToStaticMarkup(
    createElement(AppShell, {
      route,
      onRoute: vi.fn(),
      projects: [project()],
      title: "总览",
      theme,
      statusSlot: createElement("span", { "data-testid": "status-slot" }, "活动"),
      content: createElement("section", { "data-testid": "content-slot" }, "页面内容"),
      paletteSlot: createElement("div", { "data-testid": "palette-slot" }, "搜索弹层"),
      drawerSlot: createElement("div", { "data-testid": "drawer-slot" }, "任务抽屉"),
      noticeSlot: "操作完成",
      onSearch: vi.fn(),
      onToggleTheme: vi.fn(),
      onCreate: vi.fn(),
    }),
  );
}

function missingShellContracts(source: string): string[] {
  const contracts = [
    'className="atm-shell"',
    "<Sidebar",
    'className="atm-main"',
    'className="atm-topbar"',
    'className="atm-content"',
    'data-testid="window-drag-actions"',
    "onClick={onSearch}",
    "onClick={onToggleTheme}",
    "onClick={onCreate}",
    "搜索任务、记录和项目<kbd>Ctrl K</kbd>",
    "<kbd>Ctrl N</kbd>",
    'className="atm-notice" role="status"',
  ];
  return contracts.filter((contract) => !source.includes(contract));
}

describe("AppShell", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("保持 Sidebar、main、topbar、content 与 overlay slots 的 DOM 顺序", () => {
    const markup = renderShell();

    expect(markup).toContain('<div class="atm-shell">');
    expect(markup).toContain('class="atm-sidebar"');
    expect(markup).toContain('<main class="atm-main"><header class="atm-topbar">');
    expect(markup).toContain('<div class="atm-breadcrumb">总览</div>');
    expect(markup).toContain('class="atm-top-actions" data-testid="window-drag-actions"');
    expect(markup).toContain('<div class="atm-content"><section data-testid="content-slot">');
    expect(markup).toContain(
      '<div class="atm-notice" role="status" data-presence="open">操作完成</div>',
    );
    for (const [before, after] of [
      ["atm-sidebar", "atm-main"],
      ["content-slot", "palette-slot"],
      ["palette-slot", "drawer-slot"],
      ["drawer-slot", "atm-notice"],
    ]) {
      expect(markup.indexOf(before)).toBeLessThan(markup.indexOf(after));
    }
  });

  it("保持搜索、主题、新建按钮的文本和可访问名称", () => {
    const lightOverview = renderShell();
    expect(lightOverview).toContain("搜索任务、记录和项目<kbd>Ctrl K</kbd>");
    expect(lightOverview).toContain('aria-label="切换至暗黑模式" title="切换至暗黑模式"');
    expect(lightOverview).toContain("临时任务<kbd>Ctrl N</kbd>");

    const darkProject = renderShell({ route: "project:ATM", theme: "dark" });
    expect(darkProject).toContain('aria-label="切换至亮色模式" title="切换至亮色模式"');
    expect(darkProject).toContain("新建任务<kbd>Ctrl N</kbd>");
  });

  it("源码契约守卫有阳性变异红灯", () => {
    const source = readFileSync(sourcePath, "utf8");
    expect(missingShellContracts(source)).toEqual([]);

    for (const contract of [
      'className="atm-shell"',
      'data-testid="window-drag-actions"',
      "onClick={onCreate}",
    ]) {
      expect(missingShellContracts(source.replace(contract, "MUTATED"))).toContain(contract);
    }
  });
});

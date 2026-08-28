import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RegisteredProject } from "@ayanami-task/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../src/shell/sidebar.js";

const sourcePath = join(process.cwd(), "packages", "ui", "src", "shell", "sidebar.tsx");

function project(
  id: string,
  name: string,
  lifecycle: RegisteredProject["lifecycle"] = "ACTIVE",
): RegisteredProject {
  return {
    id,
    code: `P${id}`,
    name,
    lifecycle,
  } as RegisteredProject;
}

function renderSidebar(
  route: Parameters<typeof Sidebar>[0]["route"],
  projects: RegisteredProject[] = [],
  brandLogoSrc?: string,
): string {
  return renderToStaticMarkup(
    createElement(Sidebar, {
      route,
      setRoute: vi.fn(),
      projects,
      brandLogoSrc,
    }),
  );
}

function missingSidebarContracts(source: string): string[] {
  const contracts = [
    'className="atm-sidebar"',
    'className="atm-sidebar-inner"',
    'className="atm-brand" data-testid="window-drag-brand"',
    'className="atm-nav atm-nav-secondary"',
    'className="atm-nav-project"',
    'className="atm-sidebar-footer"',
    'window.localStorage.getItem("atm.workspace.expanded")',
    'window.localStorage.setItem("atm.workspace.expanded"',
    '.filter((project) => project.lifecycle === "ACTIVE")',
    ".slice(0, 12)",
  ];
  return contracts.filter((contract) => !source.includes(contract));
}

describe("Sidebar", () => {
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

  it("保持品牌、导航、项目与底部设置的 DOM 顺序和折叠默认值", () => {
    const markup = renderSidebar("overview", [project("1", "AyanamiTaskManager")]);

    expect(markup).toContain('<aside class="atm-sidebar"><div class="atm-sidebar-inner">');
    expect(markup).toContain('class="atm-brand" data-testid="window-drag-brand"');
    expect(markup).toContain("AyanamiTaskManager");
    expect(markup).toContain('aria-label="主导航"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('id="atm-workspace-navigation" aria-label="工作区" hidden=""');
    expect(markup).toContain('class="atm-sidebar-footer"');
    expect(markup.indexOf("atm-brand")).toBeLessThan(markup.indexOf("atm-primary-navigation"));
    expect(markup.indexOf("atm-primary-navigation")).toBeLessThan(
      markup.indexOf("atm-workspace-navigation"),
    );
    expect(markup.indexOf("活动项目")).toBeLessThan(markup.indexOf("atm-sidebar-footer"));
  });

  it("工作区路由强制展开并保持当前项语义", () => {
    const markup = renderSidebar("timeline");

    expect(markup).toContain('aria-expanded="true"');
    expect(markup).not.toContain('aria-label="工作区" hidden=""');
    expect(markup).toMatch(/aria-current="page"[^>]*>.*?<span>全局时间线<\/span>/u);
  });

  it("保持品牌 logo 与 fallback 行为", () => {
    expect(renderSidebar("overview", [], "/logo.png")).toContain(
      '<img src="/logo.png" alt="" aria-hidden="true"/>',
    );
    expect(renderSidebar("overview")).not.toContain("<img");
  });

  it("只显示前十二个活动项目，并保留全称和长英文提示", () => {
    const longName = "Codex Agent Permission Preflight Project";
    const projects = [
      project("0", longName),
      ...Array.from({ length: 12 }, (_, index) => project(String(index + 1), `项目 ${index + 1}`)),
      project("archived", "已归档项目", "ARCHIVED"),
    ];
    const markup = renderSidebar("project:P0", projects);

    expect(markup.match(/class="atm-nav-project"/gu)).toHaveLength(12);
    expect(markup).toContain(`aria-label="${longName}"`);
    expect(markup).toContain(`title="${longName}\n名称较长，建议改用简洁中文名称。"`);
    expect(markup).toContain(`<span class="atm-nav-project-name">${longName}</span>`);
    expect(markup).not.toContain("已归档项目");
    expect(markup).not.toContain("项目 12");
  });

  it("源码契约守卫有阳性变异红灯", () => {
    const source = readFileSync(sourcePath, "utf8");
    expect(missingSidebarContracts(source)).toEqual([]);

    for (const contract of [
      'className="atm-brand" data-testid="window-drag-brand"',
      'window.localStorage.getItem("atm.workspace.expanded")',
      '.filter((project) => project.lifecycle === "ACTIVE")',
    ]) {
      expect(missingSidebarContracts(source.replace(contract, "MUTATED"))).toContain(contract);
    }
  });
});

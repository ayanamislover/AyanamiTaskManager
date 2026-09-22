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
    'className="atm-nav atm-nav-secondary atm-disclosure-body"',
    'className="atm-nav-project"',
    'className="atm-sidebar-footer"',
    'window.localStorage.getItem("atm.workspace.expanded")',
    'window.localStorage.setItem("atm.workspace.expanded"',
    '.filter((project) => project.lifecycle === "ACTIVE")',
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

  it("仅项目列表位于滚动容器，标题、主导航和设置保留在容器之外", () => {
    const markup = renderSidebar("timeline", [project("1", "测试项目")]);
    const list = markup.match(
      /<nav class="atm-nav atm-sidebar-project-list"[^>]*>(.*?)<\/nav>/u,
    )?.[1];
    expect(list).toContain("测试项目");
    expect(list).not.toContain("atm-nav-title");
    expect(list).not.toContain("atm-sidebar-settings");
    expect(list).not.toContain("atm-primary-navigation");
    expect(markup).toContain('class="atm-sidebar-settings" aria-label="设置"');
    const css = readFileSync(join(process.cwd(), "packages/ui/src/styles/shell.css"), "utf8");
    expect(css).toMatch(/\.atm-sidebar-project-list\s*\{[^}]*overflow-y: auto/su);
    expect(css).toMatch(/\.atm-sidebar\s*\{[^}]*overflow: hidden/su);
  });

  it("保持品牌 logo 与 fallback 行为", () => {
    expect(renderSidebar("overview", [], "/logo.png")).toContain(
      '<img src="/logo.png" alt="" aria-hidden="true"/>',
    );
    expect(renderSidebar("overview")).not.toContain("<img");
  });

  it("项目行按内容撑开，拥挤时滚动而不压掉双行文字的留白", () => {
    const css = readFileSync(join(process.cwd(), "packages/ui/src/styles/shell.css"), "utf8");
    const hasContentSizedRows = (source: string) =>
      /\.atm-sidebar-project-list\s*\{[^}]*grid-auto-rows:\s*max-content/su.test(source);
    expect(hasContentSizedRows(css)).toBe(true);
    // Positive mutation control: restoring the original auto rows must fail.
    expect(
      hasContentSizedRows(css.replace("grid-auto-rows: max-content", "grid-auto-rows: auto")),
    ).toBe(false);
    expect(css).toMatch(/\.atm-sidebar-project-list\s*\{[^}]*gap: 6px/su);
    expect(css).toMatch(
      /\.atm-sidebar-project-list \.atm-nav-project\s*\{[^}]*padding: 9px 10px/su,
    );
  });

  /**
   * 以前这里写的是「只显示前十二个活动项目」——列表被 .slice(0, 12) 截断，
   * 用例把这个截断当成规格钉住了。可列表本来就是滚动容器，项目一多就凭空少几个，
   * 界面上没有任何提示。活动项目要一个不落地列出来，容不下就滚。
   */
  it("列出全部活动项目，归档的不列，长名保留全称和提示", () => {
    const longName = "Codex Agent Permission Preflight Project";
    const projects = [
      project("0", longName),
      ...Array.from({ length: 14 }, (_, index) => project(String(index + 1), `项目 ${index + 1}`)),
      project("archived", "已归档项目", "ARCHIVED"),
    ];
    const markup = renderSidebar("project:P0", projects);

    expect(markup.match(/class="atm-nav-project"/gu)).toHaveLength(15);
    expect(markup).toContain(`aria-label="${longName}"`);
    expect(markup).toContain(`title="${longName}\n名称较长，建议改用简洁中文名称。"`);
    expect(markup).toContain(`<span class="atm-nav-project-name">${longName}</span>`);
    expect(markup).not.toContain("已归档项目");
    // 第 13 个往后正是以前被吞掉的那几个。
    expect(markup).toContain("项目 12");
    expect(markup).toContain("项目 14");
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

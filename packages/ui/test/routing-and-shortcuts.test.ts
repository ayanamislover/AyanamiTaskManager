import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appRouteTitle } from "../src/routes/use-app-route.js";
import { hasActiveDialog, isEditableTarget } from "../src/hooks/use-app-shortcuts.js";

const sourceRoot = join(process.cwd(), "packages", "ui", "src");

const routeContracts = {
  initial: /useState<Route>\(\(\) => \(location\.hash\.slice\(1\) as Route\) \|\| "overview"\)/u,
  hashWrite: /useEffect\(\(\) => \{\s*location\.hash = route;\s*\}, \[route\]\)/u,
  desktopNavigate:
    /useEffect\(\(\) => desktop\?\.onNavigate\?\.\(\(next\) => setRoute\(next as Route\)\), \[desktop\]\)/u,
} as const;

const shortcutContracts = {
  editable:
    /target\.isContentEditable[\s\S]*?\["INPUT", "TEXTAREA", "SELECT"\]\.includes\(target\.tagName\)[\s\S]*?target\.closest\('\[contenteditable="true"\]'\)/u,
  modifiers: /event\.defaultPrevented[\s\S]*?!\(event\.ctrlKey \|\| event\.metaKey\)/u,
  suppressEditable: /isEditableTarget\(event\.target\)/u,
  suppressDialog: /hasActiveDialog\(\)/u,
  palette:
    /event\.key\.toLowerCase\(\) === "k"[\s\S]*?event\.preventDefault\(\);[\s\S]*?setPalette\(true\)/u,
  projectTask:
    /event\.key\.toLowerCase\(\) === "n"[\s\S]*?route\.startsWith\("project:"\)[\s\S]*?window\.dispatchEvent\(new Event\("atm:new-project-task"\)\)/u,
  quickTask: /else setRoute\("quick"\)/u,
  listener: /addEventListener\("keydown", onKey\)[\s\S]*?removeEventListener\("keydown", onKey\)/u,
  dependency: /\}, \[route\]\);/u,
} as const;

function missingContracts(source: string, contracts: Record<string, RegExp>): string[] {
  return Object.entries(contracts)
    .filter(([, pattern]) => !pattern.test(source))
    .map(([name]) => name);
}

describe("app routing and shortcuts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("保持 route title 与项目名称优先级", () => {
    expect(appRouteTitle("overview")).toBe("总览");
    expect(appRouteTitle("timeline")).toBe("全局时间线");
    expect(appRouteTitle("project:ATM", "AyanamiTaskManager")).toBe("AyanamiTaskManager");
    expect(appRouteTitle("project:MISSING")).toBe("工作区");
    expect(appRouteTitle("project:EMPTY", "")).toBe("");
  });

  it("保持 editable target 的输入控件与 contenteditable 判定", () => {
    class FakeElement {
      constructor(
        readonly tagName: string,
        readonly isContentEditable = false,
        readonly nestedEditable = false,
      ) {}
      closest() {
        return this.nestedEditable ? this : null;
      }
    }
    vi.stubGlobal("HTMLElement", FakeElement);

    expect(isEditableTarget(new FakeElement("INPUT") as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget(new FakeElement("DIV", true) as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget(new FakeElement("SPAN", false, true) as unknown as EventTarget)).toBe(
      true,
    );
    expect(isEditableTarget(new FakeElement("BUTTON") as unknown as EventTarget)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  it("仅由可交互 dialog 抑制快捷键，Presence 退出节点不会制造死区", () => {
    const root = (dialogs: Array<{ closest: () => object | null }>) =>
      ({ querySelectorAll: () => dialogs }) as unknown as ParentNode;
    expect(hasActiveDialog(root([{ closest: () => null }]))).toBe(true);
    expect(hasActiveDialog(root([{ closest: () => ({ inert: true }) }]))).toBe(false);
    expect(
      hasActiveDialog(root([{ closest: () => ({ inert: true }) }, { closest: () => null }])),
    ).toBe(true);
    expect(hasActiveDialog(root([]))).toBe(false);
  });

  it("route state/hash/desktop navigation 保持原始契约且不新增监听或校验", () => {
    const source = readFileSync(join(sourceRoot, "routes", "use-app-route.ts"), "utf8");
    expect(missingContracts(source, routeContracts)).toEqual([]);
    expect(source).not.toContain("hashchange");
    expect(source).not.toMatch(/validate|parseRoute|isRoute/u);
    for (const [name, pattern] of Object.entries(routeContracts)) {
      expect(
        missingContracts(source.replace(pattern, "/* positive mutation */"), routeContracts),
      ).toContain(name);
    }
  });

  it("快捷键保留抑制条件、Ctrl/Meta K/N、事件与 effect 依赖并能验红", () => {
    const source = readFileSync(join(sourceRoot, "hooks", "use-app-shortcuts.ts"), "utf8");
    expect(source).not.toContain("useCallback");
    expect(missingContracts(source, shortcutContracts)).toEqual([]);
    for (const [name, pattern] of Object.entries(shortcutContracts)) {
      expect(
        missingContracts(source.replace(pattern, "/* positive mutation */"), shortcutContracts),
      ).toContain(name);
    }
  });
});

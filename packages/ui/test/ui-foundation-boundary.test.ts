import { readFileSync, readdirSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = join(process.cwd(), "packages", "ui", "src");

type ProductionSource = { path: string; source: string };
type ImportEdge = { source: string; target: string };

function productionSources(root: string): ProductionSource[] {
  const files: ProductionSource[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.(?:ts|tsx)$/u.test(entry.name) && !/\.test\.(?:ts|tsx)$/u.test(entry.name)) {
        files.push({
          path: relative(root, path).replaceAll("\\", "/"),
          source: readFileSync(path, "utf8"),
        });
      }
    }
  };
  visit(root);
  return files;
}

function importEdges(files: readonly ProductionSource[]): ImportEdge[] {
  const knownPaths = new Set(files.map((file) => file.path));
  const edges: ImportEdge[] = [];
  for (const file of files) {
    for (const match of file.source.matchAll(/(?:from\s+|import\s*)["'](\.{1,2}\/[^"']+)["']/gu)) {
      const specifier = match[1]!;
      const imported = posix.normalize(posix.join(posix.dirname(file.path), specifier));
      const candidates = imported.endsWith(".js")
        ? [`${imported.slice(0, -3)}.ts`, `${imported.slice(0, -3)}.tsx`]
        : [`${imported}.ts`, `${imported}.tsx`, posix.join(imported, "index.ts")];
      const target = candidates.find((candidate) => knownPaths.has(candidate));
      if (target) edges.push({ source: file.path, target });
    }
  }
  return edges;
}

function reverseFacadeImports(files: readonly ProductionSource[]): ImportEdge[] {
  return importEdges(files).filter(
    (edge) =>
      edge.source !== "app.tsx" &&
      edge.source !== "index.ts" &&
      (edge.target === "app.tsx" || edge.target === "index.ts"),
  );
}

function appShellForbiddenImports(source: string): string[] {
  const forbidden = ["@ayanami-task/client", "@tanstack/react-query", "../app.js", "../index.js"];
  return forbidden.filter((specifier) =>
    new RegExp(`(?:from\\s+|import\\s*)["']${specifier.replaceAll("/", "\\/")}["']`, "u").test(
      source,
    ),
  );
}

describe("UI foundation boundaries", () => {
  it("公共入口仍只导出 AyanamiTaskManager", () => {
    expect(readFileSync(join(sourceRoot, "index.ts"), "utf8").trim()).toBe(
      'export { AyanamiTaskManager } from "./app.js";',
    );
  });

  it("递归扫描 production import DAG，内部模块不反向依赖 app/index", () => {
    const sources = productionSources(sourceRoot);
    expect(sources.length).toBeGreaterThanOrEqual(15);
    expect(sources.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        "app.tsx",
        "contracts.ts",
        "mcp-bridge-panel.tsx",
        "presentation.tsx",
      ]),
    );
    expect(reverseFacadeImports(sources)).toEqual([]);

    const badFixture: ProductionSource[] = [
      { path: "app.tsx", source: "export const App = {};" },
      { path: "index.ts", source: 'export { App } from "./app.js";' },
      { path: "components/deep/bad.tsx", source: 'import { App } from "../../app.js";' },
    ];
    expect(reverseFacadeImports(badFixture)).toEqual([
      { source: "components/deep/bad.tsx", target: "app.tsx" },
    ]);
  });

  it("app 使用提取后的 contracts 与 presentation，而不是保留重复声明", () => {
    const app = readFileSync(join(sourceRoot, "app.tsx"), "utf8");
    expect(app).toContain('from "./contracts.js"');
    expect(app).toContain('from "./presentation.js"');
    for (const declaration of [
      "type DesktopBridge =",
      "const statusLabels",
      "function formatTime(",
      "function AgentIntegrationBadge(",
    ]) {
      expect(app).not.toContain(declaration);
    }
  });

  it("app 使用提取后的 select/async primitives，而不是保留重复组件", () => {
    const app = readFileSync(join(sourceRoot, "app.tsx"), "utf8");
    expect(app).toContain('from "./components/atm-select.js"');
    expect(app).toContain('from "./components/async-state.js"');
    for (const declaration of [
      "type AtmSelectOption =",
      "function AtmSelect(",
      "function LoadingRows(",
      "function Empty(",
      "function ErrorState(",
      "function CursorLoadStatus(",
      "function PageHead(",
    ]) {
      expect(app).not.toContain(declaration);
    }
  });

  it("app 使用提取后的 dialog/theme/notice hooks，而不是保留重复生命周期", () => {
    const app = readFileSync(join(sourceRoot, "app.tsx"), "utf8");
    for (const module of ["use-dialog-accessibility", "use-notice", "use-theme"]) {
      expect(app).toContain(`from "./hooks/${module}.js"`);
    }
    for (const declaration of [
      'const themeStorageKey = "atm.theme"',
      "function readStoredTheme(",
      "function readSystemTheme(",
      "function persistTheme(",
      "function useDialogAccessibility(",
      "const noticeTimerRef = useRef<number | null>(null)",
    ]) {
      expect(app).not.toContain(declaration);
    }
    expect(app).toContain("const { notice, notify } = useNotice();");
    expect(app).toContain("const { theme, toggleTheme } = useTheme();");
  });

  it("app 使用提取后的 route lifecycle 与 shortcuts，而不是保留重复监听", () => {
    const app = readFileSync(join(sourceRoot, "app.tsx"), "utf8");
    expect(app).toContain('from "./routes/use-app-route.js"');
    expect(app).toContain('from "./hooks/use-app-shortcuts.js"');
    for (const call of [
      "const [route, setRoute] = useAppRouteState();",
      "useRouteHash(route);",
      "useDesktopRouteNavigation(desktop, setRoute);",
      "useAppShortcuts(route, setRoute, setPalette);",
      "appRouteTitle(route, selectedProject?.name)",
    ]) {
      expect(app).toContain(call);
    }
    for (const duplicate of [
      "useState<Route>(() => (location.hash.slice(1) as Route)",
      "location.hash = route",
      "desktop?.onNavigate?.",
      "function isEditableTarget(",
      "const onKey = (event: KeyboardEvent)",
      'overview: "总览"',
    ]) {
      expect(app).not.toContain(duplicate);
    }
  });

  it("app 使用提取后的 Sidebar，而不是保留重复 DOM 与 disclosure 状态", () => {
    const app = readFileSync(join(sourceRoot, "app.tsx"), "utf8");
    const appShell = readFileSync(join(sourceRoot, "shell", "app-shell.tsx"), "utf8");
    expect(appShell).toContain('from "./sidebar.js"');
    for (const duplicate of [
      "function Sidebar(",
      'data-testid="window-drag-brand"',
      'window.localStorage.getItem("atm.workspace.expanded")',
      'className="atm-sidebar-footer"',
    ]) {
      expect(app).not.toContain(duplicate);
    }
  });

  it("app 使用提取后的 AppShell，而不是保留重复 shell 与 topbar DOM", () => {
    const app = readFileSync(join(sourceRoot, "app.tsx"), "utf8");
    const appShell = readFileSync(join(sourceRoot, "shell", "app-shell.tsx"), "utf8");
    expect(app).toContain('from "./shell/app-shell.js"');
    for (const duplicate of [
      '<div className="atm-shell">',
      '<main className="atm-main">',
      '<header className="atm-topbar">',
      'data-testid="window-drag-actions"',
      "搜索任务、记录和项目<kbd>Ctrl K</kbd>",
    ]) {
      expect(app).not.toContain(duplicate);
    }
    expect(appShellForbiddenImports(appShell)).toEqual([]);

    const badFixture = 'import type { AyanamiClient } from "@ayanami-task/client";';
    expect(appShellForbiddenImports(badFixture)).toEqual(["@ayanami-task/client"]);
  });

  it("app 使用提取后的 Overview 与跨项目任务 feature", () => {
    const app = readFileSync(join(sourceRoot, "app.tsx"), "utf8");
    expect(app).toContain('from "./features/overview.js"');
    for (const duplicate of [
      "function OverviewPage(",
      "function useAllProjectTasks(",
      "function TasksAcrossProjects(",
      '["tasks", "all", "ui"',
    ]) {
      expect(app).not.toContain(duplicate);
    }
  });
});

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
});

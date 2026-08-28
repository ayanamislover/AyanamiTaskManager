import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cssEntryBody,
  cssImportTargets,
  readCssImportGraph,
  recursiveFiles,
  relativeToRepository,
  uiSourceRoot,
  uiStylesEntry,
} from "./css-source-graph.js";

const expectedImports = [
  "./tokens.css",
  "./styles/base.css",
  "./styles/shell.css",
  "./styles/primitives.css",
  "./styles/features-primary.css",
  "./styles/controls.css",
  "./styles/features-secondary.css",
  "./styles/overlays.css",
  "./styles/responsive.css",
  "./styles/accessibility.css",
];

function missingGraphFiles(entrySource: string): string[] {
  const imported = new Set(
    cssImportTargets(entrySource).map((target) => relativeToRepository(join(uiSourceRoot, target))),
  );
  return recursiveFiles(uiSourceRoot, ".css")
    .map(relativeToRepository)
    .filter((path) => path !== relativeToRepository(uiStylesEntry) && !imported.has(path));
}

describe("UI CSS cascade graph", () => {
  it("styles.css 只保留按原 cascade 排列的 imports", () => {
    const entry = readFileSync(uiStylesEntry, "utf8");
    expect(cssEntryBody(entry)).toBe("");
    expect(cssImportTargets(entry)).toEqual(expectedImports);

    const mutated = entry.replace('@import "./styles/controls.css";\n', "");
    expect(cssImportTargets(mutated)).not.toEqual(expectedImports);
  });

  it("import graph 递归覆盖全部 UI production CSS，删除真实 import 会验红", () => {
    const graph = readCssImportGraph().map(relativeToRepository);
    const allCss = recursiveFiles(uiSourceRoot, ".css").map(relativeToRepository).sort();
    expect([...graph].sort()).toEqual(allCss);

    const entry = readFileSync(uiStylesEntry, "utf8");
    expect(missingGraphFiles(entry)).toEqual([]);
    expect(missingGraphFiles(entry.replace('@import "./styles/controls.css";\n', ""))).toContain(
      "packages/ui/src/styles/controls.css",
    );
    expect(missingGraphFiles('@import "./tokens.css";')).not.toEqual([]);
  });
});

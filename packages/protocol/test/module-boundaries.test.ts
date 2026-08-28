import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_ROOTS = [
  resolve(process.cwd(), "packages/protocol/src"),
  resolve(process.cwd(), "packages/client/src"),
];

async function productionTypeScriptFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory()
        ? productionTypeScriptFiles(path)
        : Promise.resolve(extname(path) === ".ts" ? [path] : []);
    }),
  );
  return nested.flat();
}

function relativeModuleTargets(source: string, contents: string): string[] {
  const targets: string[] = [];
  const imports = contents.matchAll(/(?:from\s+|import\s*)["'](\.[^"']+)["']/gu);
  for (const match of imports) {
    const specifier = match[1]!;
    const resolved = resolve(dirname(source), specifier.replace(/\.js$/u, ".ts"));
    targets.push(resolved);
  }
  return targets;
}

function hasBarrelReentry(contents: string): boolean {
  return /from\s+["'][^"']*\/index\.js["']/u.test(contents);
}

function cyclicPaths(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];

  const visit = (node: string) => {
    if (active.has(node)) {
      const cycleStart = stack.indexOf(node);
      cycles.push([...stack.slice(cycleStart), node]);
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    active.add(node);
    stack.push(node);
    for (const target of graph.get(node) ?? []) {
      if (graph.has(target)) visit(target);
    }
    stack.pop();
    active.delete(node);
  };

  for (const node of graph.keys()) visit(node);
  return cycles;
}

describe("protocol/client module boundaries", () => {
  it("守卫自身能识别合成循环", () => {
    const graph = new Map([
      ["a", ["b"]],
      ["b", ["c"]],
      ["c", ["a"]],
    ]);
    expect(cyclicPaths(graph)).toEqual([["a", "b", "c", "a"]]);
    expect(hasBarrelReentry('import type { WorkItemStatus } from "../index.js";')).toBe(true);
  });

  it("所有 production TS 不超过 600 行", async () => {
    const files = (await Promise.all(SOURCE_ROOTS.map(productionTypeScriptFiles))).flat();
    const violations: string[] = [];
    for (const file of files) {
      const lines = (await readFile(file, "utf8")).split(/\r?\n/u).length;
      if (lines > 600) violations.push(`${relative(process.cwd(), file)}:${lines}`);
    }
    expect(violations).toEqual([]);
  });

  it("内部模块不回引 public index，且相对 import graph 无循环", async () => {
    const files = (await Promise.all(SOURCE_ROOTS.map(productionTypeScriptFiles))).flat();
    const graph = new Map<string, string[]>();
    const barrelReentries: string[] = [];
    for (const file of files) {
      const contents = await readFile(file, "utf8");
      graph.set(file, relativeModuleTargets(file, contents));
      if (file.endsWith("index.ts")) continue;
      if (hasBarrelReentry(contents)) {
        barrelReentries.push(relative(process.cwd(), file));
      }
    }

    expect(barrelReentries).toEqual([]);
    expect(
      cyclicPaths(graph).map((cycle) => cycle.map((file) => relative(process.cwd(), file))),
    ).toEqual([]);
  });
});

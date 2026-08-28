import { readdirSync, readFileSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

type SourceFile = { path: string; source: string };

function sourceFiles(root: string): SourceFile[] {
  const files: SourceFile[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".ts")) {
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

function moduleBoundaryViolations(files: SourceFile[]): string[] {
  const violations: string[] = [];
  const knownPaths = new Set(files.map((file) => file.path));
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const imports = [
      ...file.source.matchAll(/from\s+["']([^"']+)["']/g),
      ...file.source.matchAll(/import\s+["']([^"']+)["']/g),
    ].map((match) => match[1]!);
    const dependencies: string[] = [];
    for (const specifier of imports) {
      if (specifier === "@ayanami-task/application" || /(?:^|\/)index\.js$/.test(specifier)) {
        violations.push(`${file.path}: internal module imports the public barrel`);
      }
      if (
        file.path.startsWith("runtime/") &&
        (specifier.includes("/queries/") ||
          specifier.includes("/errors/") ||
          specifier.endsWith("/reconcile.js"))
      ) {
        violations.push(`${file.path}: runtime imports a higher application layer`);
      }
      if (file.path.startsWith("errors/") && specifier.includes("/queries/")) {
        violations.push(`${file.path}: error enrichment imports query orchestration`);
      }
      if (specifier.startsWith(".")) {
        const dependency = posix
          .normalize(posix.join(posix.dirname(file.path), specifier))
          .replace(/\.js$/, ".ts");
        if (knownPaths.has(dependency)) dependencies.push(dependency);
      }
    }
    graph.set(file.path, dependencies);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const reported = new Set<string>();
  const visit = (path: string) => {
    if (visited.has(path)) return;
    visiting.add(path);
    stack.push(path);
    for (const dependency of graph.get(path) ?? []) {
      if (visiting.has(dependency)) {
        const cycle = [...stack.slice(stack.indexOf(dependency)), dependency].join(" -> ");
        if (!reported.has(cycle)) {
          reported.add(cycle);
          violations.push(`cycle: ${cycle}`);
        }
      } else {
        visit(dependency);
      }
    }
    stack.pop();
    visiting.delete(path);
    visited.add(path);
  };
  for (const path of [...graph.keys()].sort()) {
    visit(path);
  }
  return violations;
}

describe("Application internal module boundaries", () => {
  it("keeps Runtime below Error/Queries and prevents barrel back-imports", () => {
    const root = resolve(process.cwd(), "packages/application/src");
    const files = sourceFiles(root).filter((file) =>
      ["runtime/", "errors/", "queries/"].some((prefix) => file.path.startsWith(prefix)),
    );
    expect(moduleBoundaryViolations(files)).toEqual([]);
  });

  it("proves the boundary guard rejects barrel, reverse, and cyclic imports", () => {
    const violations = moduleBoundaryViolations([
      { path: "runtime/bad.ts", source: 'import "x" from "../queries/task-queries.js";' },
      { path: "queries/bad.ts", source: 'import "x" from "../index.js";' },
      { path: "runtime/side-effect.ts", source: 'import "../queries/task-queries.js";' },
      { path: "queries/re-export.ts", source: 'export * from "../index.js";' },
      { path: "queries/a.ts", source: 'import "x" from "./b.js";' },
      { path: "queries/b.ts", source: 'import "x" from "./a.js";' },
      { path: "queries/task-queries.ts", source: "export {};" },
    ]);
    expect(violations).toContain("runtime/bad.ts: runtime imports a higher application layer");
    expect(violations).toContain("queries/bad.ts: internal module imports the public barrel");
    expect(violations).toContain(
      "runtime/side-effect.ts: runtime imports a higher application layer",
    );
    expect(violations).toContain("queries/re-export.ts: internal module imports the public barrel");
    expect(violations).toContain("cycle: queries/a.ts -> queries/b.ts -> queries/a.ts");
  });
});

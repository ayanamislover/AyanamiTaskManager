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
          specifier.includes("/commands/") ||
          specifier.includes("/coordinators/") ||
          specifier.includes("/observers/") ||
          specifier.endsWith("/reconcile.js"))
      ) {
        violations.push(`${file.path}: runtime imports a higher application layer`);
      }
      if (
        file.path.startsWith("queries/") &&
        ["/commands/", "/coordinators/", "/observers/", "/errors/"].some((segment) =>
          specifier.includes(segment),
        )
      ) {
        violations.push(`${file.path}: query imports command-side orchestration`);
      }
      if (
        file.path.startsWith("errors/") &&
        ["/queries/", "/commands/", "/coordinators/", "/observers/"].some((segment) =>
          specifier.includes(segment),
        )
      ) {
        violations.push(`${file.path}: error enrichment imports query orchestration`);
      }
      if (
        file.path.startsWith("coordinators/") &&
        ["/queries/", "/commands/", "/errors/", "/observers/"].some((segment) =>
          specifier.includes(segment),
        )
      ) {
        violations.push(`${file.path}: projection coordinator imports a peer orchestration layer`);
      }
      if (
        file.path.startsWith("observers/") &&
        ["/queries/", "/commands/", "/errors/", "/coordinators/"].some((segment) =>
          specifier.includes(segment),
        )
      ) {
        violations.push(`${file.path}: metrics observer imports a peer orchestration layer`);
      }
      if (file.path.startsWith("commands/") && specifier.includes("/queries/")) {
        violations.push(`${file.path}: command imports a read-query orchestrator`);
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

function moduleSizeViolations(
  files: SourceFile[],
  maximumLines: number,
  maximumFacadeLines: number,
): string[] {
  return files.flatMap((file) => {
    const lines = file.source.split(/\r?\n/).length;
    const maximum = file.path === "index.ts" ? maximumFacadeLines : maximumLines;
    return lines > maximum ? [`${file.path}: ${lines} lines exceeds ${maximum}`] : [];
  });
}

describe("Application internal module boundaries", () => {
  it("keeps Runtime below Queries/Commands/Coordinators/Observers and prevents cycles", () => {
    const root = resolve(process.cwd(), "packages/application/src");
    const files = sourceFiles(root).filter((file) =>
      ["runtime/", "errors/", "queries/", "commands/", "coordinators/", "observers/"].some(
        (prefix) => file.path.startsWith(prefix),
      ),
    );
    expect(moduleBoundaryViolations(files)).toEqual([]);
  });

  it("proves the boundary guard rejects barrel, reverse, and cyclic imports", () => {
    const violations = moduleBoundaryViolations([
      { path: "runtime/bad.ts", source: 'import "x" from "../queries/task-queries.js";' },
      { path: "queries/bad.ts", source: 'import "x" from "../index.js";' },
      { path: "runtime/side-effect.ts", source: 'import "../queries/task-queries.js";' },
      { path: "queries/re-export.ts", source: 'export * from "../index.js";' },
      {
        path: "queries/reverse.ts",
        source: 'import { WorkItemCommands } from "../commands/work-item-commands.js";',
      },
      {
        path: "coordinators/reverse.ts",
        source: 'import { SessionCommands } from "../commands/session-commands.js";',
      },
      {
        path: "observers/reverse.ts",
        source: 'export { ProjectQueries } from "../queries/project-queries.js";',
      },
      {
        path: "commands/reverse.ts",
        source: 'import "../queries/read-queries.js";',
      },
      { path: "queries/a.ts", source: 'import "x" from "./b.js";' },
      { path: "queries/b.ts", source: 'import "x" from "./a.js";' },
      { path: "queries/task-queries.ts", source: "export {};" },
      { path: "commands/work-item-commands.ts", source: "export {};" },
      { path: "commands/session-commands.ts", source: "export {};" },
      { path: "queries/project-queries.ts", source: "export {};" },
      { path: "queries/read-queries.ts", source: "export {};" },
    ]);
    expect(violations).toContain("runtime/bad.ts: runtime imports a higher application layer");
    expect(violations).toContain("queries/bad.ts: internal module imports the public barrel");
    expect(violations).toContain(
      "runtime/side-effect.ts: runtime imports a higher application layer",
    );
    expect(violations).toContain("queries/re-export.ts: internal module imports the public barrel");
    expect(violations).toContain("queries/reverse.ts: query imports command-side orchestration");
    expect(violations).toContain(
      "coordinators/reverse.ts: projection coordinator imports a peer orchestration layer",
    );
    expect(violations).toContain(
      "observers/reverse.ts: metrics observer imports a peer orchestration layer",
    );
    expect(violations).toContain("commands/reverse.ts: command imports a read-query orchestrator");
    expect(violations).toContain("cycle: queries/a.ts -> queries/b.ts -> queries/a.ts");
  });

  it("keeps internal modules bounded while acknowledging the facade compatibility surface", () => {
    const root = resolve(process.cwd(), "packages/application/src");
    const files = sourceFiles(root).filter(
      (file) =>
        file.path === "index.ts" ||
        ["runtime/", "errors/", "queries/", "commands/", "coordinators/", "observers/"].some(
          (prefix) => file.path.startsWith(prefix),
        ),
    );
    // Facade owner: AyanamiTaskService. Its 99 stable prototype methods and overloads must remain
    // own descriptors for downstream spies; 850 is a facade-only ceiling, never an internal budget.
    expect(moduleSizeViolations(files, 400, 850)).toEqual([]);
  });

  it("proves the module-size guard rejects oversized internal and facade modules", () => {
    const violations = moduleSizeViolations(
      [
        {
          path: "commands/oversized.ts",
          source: Array.from({ length: 402 }, () => "x").join("\n"),
        },
        { path: "index.ts", source: Array.from({ length: 852 }, () => "x").join("\n") },
      ],
      400,
      850,
    );
    expect(violations).toEqual([
      "commands/oversized.ts: 402 lines exceeds 400",
      "index.ts: 852 lines exceeds 850",
    ]);
  });
});

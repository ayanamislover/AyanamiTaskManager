import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve("packages/mcp/src");
const facadePath = "index.ts";
const maxFacadeLines = 80;
const maxModuleLines = 600;

type SourceFile = { path: string; source: string };

function productionSources(root = sourceRoot): SourceFile[] {
  const visit = (directory: string): string[] =>
    readdirSync(directory)
      .flatMap((entry) => {
        const absolute = resolve(directory, entry);
        return statSync(absolute).isDirectory() ? visit(absolute) : [absolute];
      })
      .filter((path) => path.endsWith(".ts"));
  return visit(root).map((absolute) => ({
    path: relative(root, absolute).replaceAll("\\", "/"),
    source: readFileSync(absolute, "utf8"),
  }));
}

const forbiddenPrivatePatterns = [
  { label: "SDK private registry", pattern: /_registeredTools/u },
  { label: "post-registration handler rewrite", pattern: /\.handler\s*=/u },
  { label: "post-registration enabled rewrite", pattern: /\.enabled\s*=/u },
  {
    label: "manual JSON schema path mutation",
    pattern: /\b(?:schema|item)\.properties(?:\.|\[)/u,
  },
] as const;

const forbiddenPersistencePatterns = [
  {
    label: "storage package",
    pattern: /["']@ayanami-task\/storage-sqlite(?:[/"'])/u,
  },
  { label: "SQLite driver", pattern: /["']better-sqlite3["']/u },
  {
    label: "direct SQL",
    pattern:
      /\b(?:SELECT\s+.+\s+FROM|INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+(?:TABLE|TRIGGER|INDEX)|DROP\s+(?:TABLE|TRIGGER|INDEX))\b/iu,
  },
] as const;

function layer(path: string): number {
  if (path === facadePath) return 100;
  if (path.startsWith("transports/")) return 50;
  if (path === "server.ts") return 40;
  if (path.startsWith("profiles/")) return 30;
  if (path === "tool-publication.ts" || path.startsWith("publication/")) return 20;
  return 10;
}

function resolveRelativeImport(importer: string, specifier: string): string {
  const base = importer.split("/").slice(0, -1);
  for (const segment of specifier.replace(/\.js$/u, ".ts").split("/")) {
    if (segment === ".") continue;
    if (segment === "..") base.pop();
    else base.push(segment);
  }
  return base.join("/");
}

function assertArchitecture(files: readonly SourceFile[]): void {
  const known = new Set(files.map((file) => file.path));
  const graph = new Map<string, string[]>(files.map((file) => [file.path, []]));
  for (const file of files) {
    const lineCount = file.source.split(/\r?\n/u).length;
    const maxLines = file.path === facadePath ? maxFacadeLines : maxModuleLines;
    if (lineCount > maxLines) {
      throw new Error(`MODULE_TOO_LARGE:${file.path}:${lineCount}>${maxLines}`);
    }
    if (
      file.path !== facadePath &&
      /(?:from\s+|import\s*)["'](?:\.\.\/)*index\.js["']/u.test(file.source)
    ) {
      throw new Error(`BARREL_REENTRY:${file.path}`);
    }
    for (const forbidden of forbiddenPrivatePatterns) {
      if (forbidden.pattern.test(file.source)) {
        throw new Error(`PRIVATE_TOOL_CHANNEL:${file.path}:${forbidden.label}`);
      }
    }
    for (const forbidden of forbiddenPersistencePatterns) {
      if (forbidden.pattern.test(file.source)) {
        throw new Error(`PERSISTENCE_BOUNDARY:${file.path}:${forbidden.label}`);
      }
    }
    const imports = file.source.matchAll(/(?:from\s+|import\s*)["'](\.[^"']+)["']/gu);
    for (const match of imports) {
      const target = resolveRelativeImport(file.path, match[1]!);
      if (!known.has(target)) continue;
      graph.get(file.path)!.push(target);
      if (file.path === facadePath) continue;
      if (layer(target) > layer(file.path)) {
        throw new Error(`REVERSE_IMPORT:${file.path}->${target}`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (path: string): void => {
    if (visiting.has(path)) {
      const start = stack.indexOf(path);
      throw new Error(`IMPORT_CYCLE:${[...stack.slice(start), path].join("->")}`);
    }
    if (visited.has(path)) return;
    visiting.add(path);
    stack.push(path);
    for (const target of graph.get(path) ?? []) visit(target);
    stack.pop();
    visiting.delete(path);
    visited.add(path);
  };
  for (const path of graph.keys()) visit(path);
}

describe("MCP recursive module architecture", () => {
  it("keeps the facade thin, modules bounded and imports one-way", () => {
    expect(() => assertArchitecture(productionSources())).not.toThrow();
  });

  it("proves every architecture channel can turn red", () => {
    const valid: SourceFile[] = [
      { path: "index.ts", source: 'export * from "./server.js";\n' },
      { path: "server.ts", source: 'import "./profiles/registry.js";\n' },
      { path: "profiles/registry.ts", source: 'import "../result.js";\n' },
      { path: "result.ts", source: "export const ok = true;\n" },
    ];
    expect(() => assertArchitecture(valid)).not.toThrow();

    const oversized = [{ path: "index.ts", source: "\n".repeat(maxFacadeLines + 1) }];
    expect(() => assertArchitecture(oversized)).toThrow("MODULE_TOO_LARGE:index.ts");

    const barrelReentry = [
      ...valid,
      { path: "paging/task.ts", source: 'import { mcpResult } from "../index.js";\n' },
    ];
    expect(() => assertArchitecture(barrelReentry)).toThrow("BARREL_REENTRY:paging/task.ts");

    const reverseImport = valid.map((file) =>
      file.path === "result.ts" ? { ...file, source: 'import "./server.js";\n' } : file,
    );
    expect(() => assertArchitecture(reverseImport)).toThrow("REVERSE_IMPORT:result.ts->server.ts");

    const cycle: SourceFile[] = [
      { path: "index.ts", source: 'export * from "./profiles/a.js";\n' },
      { path: "profiles/a.ts", source: 'import "./b.js";\n' },
      { path: "profiles/b.ts", source: 'import "./a.js";\n' },
    ];
    expect(() => assertArchitecture(cycle)).toThrow("IMPORT_CYCLE:profiles/a.ts->profiles/b.ts");

    const privateSdk = valid.map((file) =>
      file.path === "server.ts"
        ? { ...file, source: `${file.source}server._registeredTools;\n` }
        : file,
    );
    expect(() => assertArchitecture(privateSdk)).toThrow("PRIVATE_TOOL_CHANNEL:server.ts");

    const storageImport = valid.map((file) =>
      file.path === "result.ts"
        ? { ...file, source: 'import Database from "better-sqlite3";\n' }
        : file,
    );
    expect(() => assertArchitecture(storageImport)).toThrow(
      "PERSISTENCE_BOUNDARY:result.ts:SQLite driver",
    );

    const packageImport = valid.map((file) =>
      file.path === "result.ts"
        ? { ...file, source: 'import { ProjectRepository } from "@ayanami-task/storage-sqlite";\n' }
        : file,
    );
    expect(() => assertArchitecture(packageImport)).toThrow(
      "PERSISTENCE_BOUNDARY:result.ts:storage package",
    );

    const directSql = valid.map((file) =>
      file.path === "result.ts"
        ? { ...file, source: 'database.prepare("SELECT * FROM work_items");\n' }
        : file,
    );
    expect(() => assertArchitecture(directSql)).toThrow(
      "PERSISTENCE_BOUNDARY:result.ts:direct SQL",
    );
  });
});

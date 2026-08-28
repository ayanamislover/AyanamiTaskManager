import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = join(process.cwd(), "packages", "agent-config", "src");

type SourceFile = { path: string; source: string };

function sourceFiles(root = sourceRoot): SourceFile[] {
  return readdirSync(root)
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => ({
      path: relative(process.cwd(), join(root, name)).replaceAll("\\", "/"),
      source: readFileSync(join(root, name), "utf8"),
    }));
}

function lineCount(source: string): number {
  return source.replaceAll("\r\n", "\n").split("\n").length;
}

function findLineBudgetViolations(files: SourceFile[], maximum = 600): string[] {
  return files.flatMap((file) => {
    const lines = lineCount(file.source);
    return lines > maximum ? [`${file.path}: ${lines} lines exceeds ${maximum}`] : [];
  });
}

function findFacadeReentry(files: SourceFile[]): string[] {
  return files.flatMap((file) => {
    if (file.path.endsWith("/src/index.ts")) return [];
    return /(?:from\s+|import\s*\()['"]\.\/index\.js['"]/u.test(file.source)
      ? [`${file.path}: module must not re-enter the public facade`]
      : [];
  });
}

describe("agent-config architecture guards", () => {
  it("keeps every production TypeScript module within the 600-line budget", () => {
    expect(findLineBudgetViolations(sourceFiles())).toEqual([]);
  });

  it("keeps domain modules below the public facade", () => {
    expect(findFacadeReentry(sourceFiles())).toEqual([]);
  });

  it("turns red for a mutated over-budget module", () => {
    const mutated: SourceFile = {
      path: "packages/agent-config/src/mutated.ts",
      source: `export const mutation = true;\n${"// mutation\n".repeat(600)}`,
    };
    expect(findLineBudgetViolations([mutated])).toEqual([
      "packages/agent-config/src/mutated.ts: 602 lines exceeds 600",
    ]);
  });

  it("turns red for a mutated facade re-entry import", () => {
    const mutated: SourceFile = {
      path: "packages/agent-config/src/mutated.ts",
      source: 'import { installClaudeConfig } from "./index.js";\n',
    };
    expect(findFacadeReentry([mutated])).toEqual([
      "packages/agent-config/src/mutated.ts: module must not re-enter the public facade",
    ]);
  });
});

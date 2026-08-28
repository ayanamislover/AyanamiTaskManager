import { readdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const forbiddenAttach = /\bATTACH\s+(?:DATABASE\s+)?/iu;

function productionSqlFiles(root: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) results.push(...productionSqlFiles(path));
    else if ([".sql", ".ts"].includes(extname(entry.name))) results.push(path);
  }
  return results;
}

function attachViolations(files: Array<{ path: string; source: string }>): string[] {
  return files.filter((file) => forbiddenAttach.test(file.source)).map((file) => file.path);
}

describe("本地安全模型 SQL 边界", () => {
  it("项目数据库生产 SQL 不得跨库 ATTACH，且守卫有阳性对照", () => {
    const paths = [
      ...productionSqlFiles(resolve(process.cwd(), "packages/storage-sqlite/src")),
      ...productionSqlFiles(resolve(process.cwd(), "migrations")),
    ];
    expect(paths.length).toBeGreaterThan(10);
    const production = paths.map((path) => ({ path, source: readFileSync(path, "utf8") }));
    expect(attachViolations(production)).toEqual([]);
    expect(
      attachViolations([
        ...production,
        { path: "positive-fixture.sql", source: "ATTACH DATABASE 'foreign.sqlite' AS foreign;" },
      ]),
    ).toContain("positive-fixture.sql");
  });
});

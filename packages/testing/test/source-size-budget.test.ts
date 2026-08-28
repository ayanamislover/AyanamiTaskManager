import { describe, expect, it } from "vitest";
import {
  auditSourceSizes,
  collectRepositorySources,
  readArchitectureExceptions,
  type ProductionSourceFile,
} from "./support/architecture-policy.js";

const repositoryRoot = process.cwd();
function file(
  path: string,
  lines: number,
  sql = false,
  lineEnding = "\n",
  terminalNewline = true,
): ProductionSourceFile {
  const sourceLines = Array.from({ length: lines }, (_, index) =>
    sql && index === 0 ? "database.prepare('SELECT 1');" : "// line",
  );
  return {
    path,
    packageName: "@ayanami-task/testing",
    source: `${sourceLines.join(lineEnding)}${terminalNewline ? lineEnding : ""}`,
  };
}

describe("production Module source-size budget", () => {
  it("真实 production 源码满足600行与有理由的SQL-heavy 1000行上限", () => {
    const inventory = collectRepositorySources(repositoryRoot);
    expect(auditSourceSizes(inventory.files, readArchitectureExceptions(repositoryRoot))).toEqual(
      [],
    );
  });

  it("600/601 与例外 limit 边界会真实验红", () => {
    expect(auditSourceSizes([file("packages/testing/src/exact.ts", 600)], [])).toEqual([]);
    expect(auditSourceSizes([file("packages/testing/src/too-large.ts", 601)], [])).toMatchObject([
      { code: "SOURCE_SIZE_LIMIT", path: "packages/testing/src/too-large.ts" },
    ]);
    expect(
      auditSourceSizes([file("packages/storage-sqlite/src/sql.ts", 601, true)], []),
    ).toMatchObject([{ code: "SQL_HEAVY_EXCEPTION_REQUIRED" }]);
    expect(
      auditSourceSizes([file("packages/testing/src/no-terminal.ts", 600, false, "\n", false)], []),
    ).toEqual([]);
    expect(
      auditSourceSizes(
        [file("packages/testing/src/no-terminal-large.ts", 601, false, "\n", false)],
        [],
      ),
    ).toMatchObject([{ code: "SOURCE_SIZE_LIMIT" }]);
    expect(
      auditSourceSizes([file("packages/testing/src/crlf.ts", 600, false, "\r\n")], []),
    ).toEqual([]);
    expect(
      auditSourceSizes([file("packages/testing/src/crlf-large.ts", 601, false, "\r\n")], []),
    ).toMatchObject([{ code: "SOURCE_SIZE_LIMIT" }]);
    const exception = [
      {
        path: "packages/storage-sqlite/src/sql.ts",
        limit: 1_000,
        owner: "testing/architecture",
        reason:
          "SQL-heavy fixture keeps transaction and query semantics together behind one test Seam.",
      },
    ];
    expect(
      auditSourceSizes([file("packages/storage-sqlite/src/sql.ts", 1_000, true)], exception),
    ).toEqual([]);
    expect(
      auditSourceSizes([file("packages/storage-sqlite/src/sql.ts", 1_001, true)], exception),
    ).toMatchObject([{ code: "SIZE_EXCEPTION_EXCEEDED" }]);
  });

  it("缺失、重复、回落后未清理、无理由和越界例外都会验红", () => {
    const valid = {
      path: "packages/testing/src/large.ts",
      limit: 700,
      owner: "testing/architecture",
      reason:
        "Stable fixture Interface deliberately exceeds the default while preserving Locality.",
    };
    const large = file(valid.path, 650);
    expect(auditSourceSizes([large], [valid, valid]).map((entry) => entry.code)).toContain(
      "DUPLICATE_SIZE_EXCEPTION",
    );
    expect(auditSourceSizes([], [valid]).map((entry) => entry.code)).toContain(
      "SIZE_EXCEPTION_PATH_MISSING",
    );
    expect(auditSourceSizes([file(valid.path, 600)], [valid]).map((entry) => entry.code)).toContain(
      "STALE_SIZE_EXCEPTION",
    );
    expect(
      auditSourceSizes([large], [{ ...valid, owner: "" }]).map((entry) => entry.code),
    ).toContain("INVALID_SIZE_EXCEPTION");
    expect(
      auditSourceSizes([large], [{ ...valid, reason: "short" }]).map((entry) => entry.code),
    ).toContain("INVALID_SIZE_EXCEPTION");
    expect(
      auditSourceSizes([large], [{ ...valid, limit: 1_001 }]).map((entry) => entry.code),
    ).toContain("INVALID_SIZE_EXCEPTION");
    expect(
      auditSourceSizes([large], [{ ...valid, path: "packages\\testing\\src\\large.ts" }]).map(
        (entry) => entry.code,
      ),
    ).toContain("INVALID_SIZE_EXCEPTION");
    expect(
      auditSourceSizes([large], [{ ...valid, undocumented: true }]).map((entry) => entry.code),
    ).toContain("INVALID_SIZE_EXCEPTION");
    expect(auditSourceSizes([large], { entries: [valid] })).toMatchObject([
      { code: "INVALID_EXCEPTION_CATALOG" },
    ]);
  });
});

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

type WorkItemUpdateInspection = {
  lexicalUpdateCount: number;
  statements: Array<{
    line: number;
    changesStatus: boolean;
    changesPhase: boolean;
  }>;
};

const updateWorkItemsPattern = /\bUPDATE\s+work_items\s+SET\b/gi;
const setClausePattern = /\bUPDATE\s+work_items\s+SET\b([\s\S]*?)(?:\bWHERE\b|$)/i;
const statusAssignmentPattern = /(?:^|,)\s*status\s*=/i;
const phaseAssignmentPattern = /(?:^|,)\s*phase\s*=/i;

function inspectWorkItemUpdates(source: string): WorkItemUpdateInspection {
  const sourceFile = ts.createSourceFile(
    "project-repository.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const statements: WorkItemUpdateInspection["statements"] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node)
    ) {
      const sql = node.getText(sourceFile);
      const setClause = setClausePattern.exec(sql)?.[1];
      if (setClause !== undefined) {
        statements.push({
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          changesStatus: statusAssignmentPattern.test(setClause),
          changesPhase: phaseAssignmentPattern.test(setClause),
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return {
    lexicalUpdateCount: source.match(updateWorkItemsPattern)?.length ?? 0,
    statements,
  };
}

describe("work_items 状态与阶段 SQL 守卫", () => {
  it("能识别故意遗漏 phase 的坏 SQL 阳性对照", () => {
    const inspection = inspectWorkItemUpdates(`
      const sql = "UPDATE work_items SET status = 'DONE', updated_at = ? WHERE id = ?";
    `);

    expect(inspection.lexicalUpdateCount).toBe(1);
    expect(inspection.statements).toHaveLength(1);
    expect(inspection.statements.filter((statement) => statement.changesStatus)).toHaveLength(1);
    expect(inspection.statements.filter((statement) => statement.changesPhase)).toHaveLength(0);
  });

  it("扫描全部 UPDATE work_items SQL，status 赋值必须同时写 phase", () => {
    const sourceDirectory = fileURLToPath(new URL("../src/", import.meta.url));
    const inspections = readdirSync(sourceDirectory)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => inspectWorkItemUpdates(readFileSync(join(sourceDirectory, name), "utf8")));
    const lexicalUpdateCount = inspections.reduce(
      (total, inspection) => total + inspection.lexicalUpdateCount,
      0,
    );
    const statements = inspections.flatMap((inspection) => inspection.statements);
    const statusUpdates = statements.filter((statement) => statement.changesStatus);

    expect(lexicalUpdateCount).toBeGreaterThan(0);
    expect(statements).toHaveLength(lexicalUpdateCount);
    expect(statusUpdates.length).toBeGreaterThan(0);
    expect(statusUpdates.filter((statement) => !statement.changesPhase)).toEqual([]);
  });
});

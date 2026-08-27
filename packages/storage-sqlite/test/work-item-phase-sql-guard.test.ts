import { readFileSync } from "node:fs";
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
    const repositoryPath = fileURLToPath(new URL("../src/project-repository.ts", import.meta.url));
    const source = readFileSync(repositoryPath, "utf8");
    const inspection = inspectWorkItemUpdates(source);
    const statusUpdates = inspection.statements.filter((statement) => statement.changesStatus);

    expect(inspection.lexicalUpdateCount).toBeGreaterThan(0);
    expect(inspection.statements).toHaveLength(inspection.lexicalUpdateCount);
    expect(statusUpdates.length).toBeGreaterThan(0);
    expect(statusUpdates.filter((statement) => !statement.changesPhase)).toEqual([]);
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type AdapterSources = {
  actions: string;
  coreTasks: string;
  result: string;
};

function productionSources(): AdapterSources {
  const read = (path: string): string => readFileSync(resolve("packages/mcp/src", path), "utf8");
  return {
    actions: read("tools/actions/task-patch.ts"),
    coreTasks: read("tools/core/task-list.ts"),
    result: read("result.ts"),
  };
}

function assertApplicationOwnsBusinessDecisions(sources: AdapterSources): void {
  const checks = [
    {
      label: "review binding preflight",
      source: sources.actions,
      pattern: /\.getReviewRequest\s*\(/u,
    },
    {
      label: "transport business error",
      source: sources.actions,
      pattern: /\bnew\s+AtmError\s*\(/u,
    },
    {
      label: "transport mutation enrichment",
      source: sources.actions,
      pattern: /\bwithMcpErrorDetails\s*\(/u,
    },
    {
      label: "transport expected-version map",
      source: sources.actions,
      pattern: /\bexpectedVersions\s*:/u,
    },
    {
      label: "transport reconciliation scan",
      source: sources.coreTasks,
      pattern: /\.reconcileProject\s*\(/u,
    },
    {
      label: "transport error context",
      source: sources.result,
      pattern: /\b(?:taskKey|checklistId|expectedVersion|expectedVersions)\??\s*:/u,
    },
  ] as const;

  for (const check of checks) {
    if (check.pattern.test(check.source)) {
      throw new Error(`MCP_BUSINESS_PREFLIGHT:${check.label}`);
    }
  }
}

describe("MCP application boundary", () => {
  it("keeps business validation, paging and mutation error details in Application", () => {
    expect(() => assertApplicationOwnsBusinessDecisions(productionSources())).not.toThrow();
  });

  it("proves every preflight channel can turn red", () => {
    const valid: AdapterSources = {
      actions: "return service.submitReview(input);\n",
      coreTasks: "return service.reconcileProjectPage(input);\n",
      result: "type McpErrorContext = { project?: string };\n",
    };
    expect(() => assertApplicationOwnsBusinessDecisions(valid)).not.toThrow();

    const mutations: Array<[keyof AdapterSources, string, string]> = [
      ["actions", "service.getReviewRequest(project, key);", "review binding preflight"],
      ["actions", 'throw new AtmError("VERSION_CONFLICT");', "transport business error"],
      [
        "actions",
        "withMcpErrorDetails(service, context, action);",
        "transport mutation enrichment",
      ],
      [
        "actions",
        "const context = { expectedVersions: versions };",
        "transport expected-version map",
      ],
      ["coreTasks", "service.reconcileProject(project);", "transport reconciliation scan"],
      ["result", "type McpErrorContext = { taskKey?: string };", "transport error context"],
    ];
    for (const [key, mutation, label] of mutations) {
      expect(() =>
        assertApplicationOwnsBusinessDecisions({ ...valid, [key]: `${valid[key]}${mutation}` }),
      ).toThrow(`MCP_BUSINESS_PREFLIGHT:${label}`);
    }
  });
});

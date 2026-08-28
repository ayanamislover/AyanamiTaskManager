import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AyanamiClient, RegisteredProject } from "@ayanami-task/client";
import { describe, expect, it, vi } from "vitest";
import { QuickPage } from "../src/features/quick.js";

const sourcePath = join(process.cwd(), "packages", "ui", "src", "features", "quick.tsx");

function client(): AyanamiClient {
  return {
    quick: { list: vi.fn(), create: vi.fn(), patch: vi.fn(), promote: vi.fn() },
    projects: { list: vi.fn() },
  } as unknown as AyanamiClient;
}

function project(overrides: Partial<RegisteredProject> = {}): RegisteredProject {
  return {
    id: "project-id",
    code: "ATM",
    name: "AyanamiTaskManager",
    lifecycle: "ACTIVE",
    sourcePaths: [],
    ...overrides,
  } as RegisteredProject;
}

function renderWithClient(queryClient: QueryClient, child: ReturnType<typeof createElement>) {
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: queryClient }, child));
}

function missingQuickContracts(source: string): string[] {
  const contracts = [
    'queryKey: ["quick"]',
    'queryKey: ["projects"]',
    'projects.data?.find((project) => project.lifecycle === "ACTIVE")?.code ?? ""',
    '.filter((project) => project.lifecycle === "ACTIVE")',
    'client.quick.create({ title, note: "", actor: "USER" })',
    'queryClient.invalidateQueries({ queryKey: ["quick"] })',
    'queryClient.invalidateQueries({ queryKey: ["overview"] })',
    'client.quick.patch(id, { status, expectedVersion: version, actor: "USER" })',
    "client.quick.promote(task.id, {",
    "targetProjectCode: targetProject",
    "await queryClient.invalidateQueries();",
    "if (title.trim()) create.mutate();",
    '["OPEN", "IN_PROGRESS", "BLOCKED"]',
  ];
  return contracts.filter((contract) => !source.includes(contract));
}

describe("Quick feature", () => {
  it("保持临时任务、活动项目选项与动作 DOM", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      ["quick"],
      [
        {
          id: "quick-1",
          key: "Q-1",
          title: "验证临时任务",
          status: "OPEN",
          version: 3,
          updatedAt: "2026-08-28T00:00:00.000Z",
        },
      ],
    );
    queryClient.setQueryData(
      ["projects"],
      [
        project(),
        project({ id: "archive-id", code: "ARC", name: "归档项目", lifecycle: "ARCHIVED" }),
      ],
    );

    const markup = renderWithClient(
      queryClient,
      createElement(QuickPage, { client: client(), notify: vi.fn() }),
    );

    expect(markup).toContain("一次性、低复杂度工作留在全局注册库");
    expect(markup).toContain('aria-label="晋升目标项目"');
    expect(markup).toContain('placeholder="添加一件临时任务"');
    expect(markup).toContain("验证临时任务");
    expect(markup).toContain("晋升");
    expect(markup).toContain('aria-label="开始"');
    expect(markup).toContain('aria-label="完成"');
  });

  it("创建、patch、晋升、默认项目与 invalidation 契约有阳性变异红灯", () => {
    const source = readFileSync(sourcePath, "utf8");
    expect(missingQuickContracts(source)).toEqual([]);

    for (const contract of [
      'client.quick.create({ title, note: "", actor: "USER" })',
      "targetProjectCode: targetProject",
      '["OPEN", "IN_PROGRESS", "BLOCKED"]',
    ]) {
      expect(missingQuickContracts(source.replaceAll(contract, "MUTATED"))).toContain(contract);
    }
  });
});

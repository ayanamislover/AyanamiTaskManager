import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AyanamiClient } from "@ayanami-task/client";
import { describe, expect, it, vi } from "vitest";
import {
  ProjectDiagnostics,
  projectDiagnosticsNeedAttention,
} from "../src/features/project-diagnostics.js";

describe("项目诊断区", () => {
  it("只有对账检查本身失败才需要自动展开：3.0 单库没有投影可以落后", () => {
    expect(projectDiagnosticsNeedAttention({ reconciliationError: null })).toBe(false);
    expect(projectDiagnosticsNeedAttention({ reconciliationError: new Error("x") })).toBe(true);
  });

  it("折叠时只渲染折叠条，不挂载对账和工程统计面板；投影面板已删除", () => {
    const markup = (open: boolean) =>
      renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(ProjectDiagnostics, {
            client: {
              projects: {
                reconciliation: vi.fn(),
                engineeringMetrics: vi.fn(),
              },
            } as unknown as AyanamiClient,
            projectCode: "ATM",
            openTask: vi.fn(),
            diagnostics: {
              attention: false,
              atTop: false,
              open,
              setOpen: vi.fn(),
              reconciliationAttention: 2,
            },
          }),
        ),
      );
    const collapsed = markup(false);
    expect(collapsed).toContain('aria-label="展开项目诊断"');
    expect(collapsed).toContain("需对账 2 项");
    for (const panel of ['aria-label="任务对账"', 'aria-label="工程统计"'])
      expect(collapsed).not.toContain(panel);

    const expanded = markup(true);
    for (const panel of ['aria-label="任务对账"', 'aria-label="工程统计"'])
      expect(expanded).toContain(panel);
    for (const view of [collapsed, expanded]) {
      expect(view).not.toContain("数据投影");
      expect(view).not.toContain("已追平");
    }
  });
});

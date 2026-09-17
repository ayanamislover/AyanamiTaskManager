import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AyanamiClient } from "@ayanami-task/client";
import { describe, expect, it, vi } from "vitest";
import {
  ProjectDiagnostics,
  projectDiagnosticsNeedAttention,
} from "../src/features/project-diagnostics.js";

const applied = {
  status: "APPLIED" as const,
  sourceSeq: 3,
  projectedSeq: 3,
  lag: 0,
  retryScheduled: false,
  lastError: null,
  retryCount: 0,
  updatedAt: "2026-09-17T00:00:00.000Z",
};

describe("项目诊断区", () => {
  it("只有真出错才需要自动展开：投影没追平、带错误、状态缺失或对账检查失败", () => {
    const base = { overviewLoaded: true, projection: applied, reconciliationError: null };
    expect(projectDiagnosticsNeedAttention(base)).toBe(false);
    expect(
      projectDiagnosticsNeedAttention({ ...base, projection: { ...applied, status: "DEFERRED" } }),
    ).toBe(true);
    expect(
      projectDiagnosticsNeedAttention({ ...base, projection: { ...applied, lastError: "boom" } }),
    ).toBe(true);
    expect(projectDiagnosticsNeedAttention({ ...base, projection: null })).toBe(true);
    expect(projectDiagnosticsNeedAttention({ ...base, reconciliationError: new Error("x") })).toBe(
      true,
    );
    // 总览还没加载完时不能把「没有投影状态」当成出错，否则每次打开项目页都会闪一下展开。
    expect(
      projectDiagnosticsNeedAttention({ ...base, overviewLoaded: false, projection: null }),
    ).toBe(false);
  });

  it("折叠时只渲染折叠条，不挂载投影、对账和工程统计面板", () => {
    const markup = (open: boolean) =>
      renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(ProjectDiagnostics, {
            client: {
              projects: {
                reconciliation: vi.fn(),
                reconcileProjection: vi.fn(),
                engineeringMetrics: vi.fn(),
              },
            } as unknown as AyanamiClient,
            projectCode: "ATM",
            notify: vi.fn(),
            openTask: vi.fn(),
            diagnostics: {
              attention: false,
              atTop: false,
              open,
              setOpen: vi.fn(),
              projection: applied,
              reconciliationAttention: 2,
            },
          }),
        ),
      );
    const collapsed = markup(false);
    expect(collapsed).toContain('aria-label="展开项目诊断"');
    expect(collapsed).toContain("已追平");
    expect(collapsed).toContain("需对账 2 项");
    for (const panel of ['aria-label="数据投影"', 'aria-label="任务对账"', 'aria-label="工程统计"'])
      expect(collapsed).not.toContain(panel);

    const expanded = markup(true);
    for (const panel of ['aria-label="数据投影"', 'aria-label="任务对账"', 'aria-label="工程统计"'])
      expect(expanded).toContain(panel);
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { EngineeringMetricsPanel } from "../src/project-statistics-panel.js";

function renderPanel(
  engineeringMetrics: (code: string, task?: string, refresh?: boolean) => Promise<any>,
  cached?: Record<string, any>,
): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (cached) queryClient.setQueryData(["engineering-metrics", "ATM"], cached);
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(EngineeringMetricsPanel, {
        client: { projects: { engineeringMetrics } } as never,
        projectCode: "ATM",
        formatCapturedAt: (value: unknown) => String(value ?? ""),
      }),
    ),
  );
}

describe("EngineeringMetricsPanel", () => {
  it("默认折叠并且不主动触发工程统计", () => {
    const engineeringMetrics = vi.fn(async () => ({ available: false }));

    const markup = renderPanel(engineeringMetrics);

    expect(markup).toContain('aria-label="展开工程统计"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('id="engineering-metrics-content" hidden=""');
    expect(markup).not.toContain("刷新统计");
    expect(engineeringMetrics).not.toHaveBeenCalled();
  });

  it("展示缓存中的项目指标、规模警告并限制热点文件数量", () => {
    const engineeringMetrics = vi.fn(async () => ({ available: false }));
    const largestFiles = Array.from({ length: 7 }, (_, index) => ({
      path: `src/file-${index + 1}.ts`,
      loc: 100 + index,
    }));
    const highChurnFiles = Array.from({ length: 7 }, (_, index) => ({
      path: `src/churn-${index + 1}.ts`,
      churn: 200 + index,
    }));

    const markup = renderPanel(engineeringMetrics, {
      available: true,
      project: {
        sourceLoc: 12_345,
        testLoc: 2_345,
        fileCount: 321,
        dependencyCount: 42,
        netLoc7d: 5_001,
        netLoc30d: 8_765,
        largestFiles,
        highChurnFiles,
        head: "1234567890abcdef",
        capturedAt: "2026-08-27T00:00:00.000Z",
      },
    });

    expect(markup).toContain("12,345");
    expect(markup).toContain("最近 7 日实现规模偏大");
    expect(markup).toContain("src/file-6.ts");
    expect(markup).not.toContain("src/file-7.ts");
    expect(markup).toContain("src/churn-6.ts");
    expect(markup).not.toContain("src/churn-7.ts");
    expect(markup).toContain("HEAD 1234567890");
    expect(markup).toContain("2026-08-27T00:00:00.000Z");
  });

  it("把缺少源码目录显示为明确的不可统计原因", () => {
    const markup = renderPanel(
      vi.fn(async () => ({ available: false })),
      {
        available: false,
        reason: "NO_SOURCE_PATH",
      },
    );

    expect(markup).toContain("此项目暂不可统计");
    expect(markup).toContain("项目没有源码目录");
  });
});

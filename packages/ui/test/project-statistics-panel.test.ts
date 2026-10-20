import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import {
  EngineeringMetricsPanel,
  engineeringUnavailable,
} from "../src/project-statistics-panel.js";

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

  it("展示缓存中的项目指标、规模警告与服务端给出的全部热点文件", () => {
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
    // 服务端 scanProjectMetrics 已按 topN 截过一次，界面再砍一刀只会白丢两条。
    expect(markup).toContain("src/file-7.ts");
    expect(markup).toContain("src/churn-7.ts");
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

  // W8g（W2 peer r3 P2-02）：读从不当场扫，「还没统计过」不能显示成目录故障。
  it("还没统计过（NO_DATA）提示去刷新，不说源码目录有问题", () => {
    const markup = renderPanel(
      vi.fn(async () => ({ available: false })),
      {
        available: false,
        reason: "NO_DATA",
        message: "还没有统计：点「刷新统计」",
        project: null,
        workItem: null,
      },
    );

    expect(markup).toContain("还没有统计");
    expect(markup).toContain("点「刷新统计」，按本地 Git 与文件算一次");
    expect(markup).not.toContain("此项目暂不可统计");
    expect(markup).not.toContain("不是可读取的 Git 仓库");
  });

  it("只有任务指标、还没有项目指标：不读空的项目指标，同样提示去刷新", () => {
    const markup = renderPanel(
      vi.fn(async () => ({ available: false })),
      {
        available: true,
        reason: null,
        project: null,
        workItem: { taskKey: "ATM-T-0001", metrics: { added: 3 } },
      },
    );

    expect(markup).toContain("还没有统计");
    expect(markup).not.toContain("Source LOC");
  });

  it("刷新时 git 失败：显示服务端的说明", () => {
    expect(
      engineeringUnavailable({
        available: false,
        reason: "METRICS_FAILED",
        message: "git rev-parse 失败",
      }),
    ).toEqual({ title: "此项目暂不可统计", detail: "git rev-parse 失败" });
    expect(engineeringUnavailable({ available: false })).toEqual({
      title: "此项目暂不可统计",
      detail: "源码目录不是可读取的 Git 仓库",
    });
    expect(engineeringUnavailable({ available: false, reason: "NO_SOURCE_PATH" }).detail).toBe(
      "项目没有源码目录",
    );
  });

  it("读失败时给出可重试的行内错误，不拿「不可统计」顶替", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient
      .getQueryCache()
      .build(queryClient, { queryKey: ["engineering-metrics", "ATM"] })
      .setState({
        status: "error",
        error: new Error("UI_BRIDGE_UNAVAILABLE"),
        fetchStatus: "idle",
      });
    const markup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(EngineeringMetricsPanel, {
          client: { projects: { engineeringMetrics: vi.fn() } } as never,
          projectCode: "ATM",
          formatCapturedAt: (value: unknown) => String(value ?? ""),
        }),
      ),
    );

    expect(markup).toContain("工程统计没能读出来。");
    expect(markup).toContain("重试");
    expect(markup).not.toContain("此项目暂不可统计");
  });
});

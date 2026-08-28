import { createElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type {
  ProjectionFailureView,
  ProjectionStateView,
  ProjectionSummary,
} from "@ayanami-task/protocol";
import {
  ProjectProjectionPanel,
  SystemProjectionPanel,
  invalidateProjectionQueries,
} from "../src/projection-health-panel.js";

const project = {
  id: "project-id",
  code: "ATM",
  name: "AyanamiTaskManager",
  lifecycle: "ACTIVE",
};

const deferred: ProjectionStateView = {
  project,
  status: "DEFERRED",
  sourceSeq: 12,
  projectedSeq: 9,
  lag: 3,
  retryScheduled: true,
  lastError: "Registry 暂时不可写，但项目权威写入已经成功，等待再次投影。".repeat(6),
  retryCount: 2,
  updatedAt: "2026-08-28T02:00:00.000Z",
};

function render(element: ReturnType<typeof createElement>): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: queryClient }, element));
}

describe("projection health panels", () => {
  it("renders project retry state in the existing design system with a bounded titled error", () => {
    const markup = render(
      createElement(ProjectProjectionPanel, {
        client: { projects: { reconcileProjection: vi.fn() } } as never,
        projectCode: "ATM",
        state: deferred,
      }),
    );

    expect(markup).toContain('class="atm-panel atm-projection-panel"');
    expect(markup).toContain('class="atm-badge warning"');
    expect(markup).toContain("等待重试");
    expect(markup).toContain("lag 3");
    expect(markup).toContain('class="atm-inline-error atm-projection-error"');
    expect(markup).toContain(`title="${deferred.lastError}`);
    expect(markup).toContain("立即重试");
    const styles = readFileSync(resolve("packages/ui/src/styles.css"), "utf8");
    expect(styles).toMatch(
      /\.atm-projection-error\s*\{[^}]*display:\s*-webkit-box;[^}]*overflow:\s*hidden;[^}]*-webkit-line-clamp:\s*2;/su,
    );
  });

  it("renders global summary and retry-all action without turning DEFERRED into a fatal state", () => {
    const summary: ProjectionSummary = {
      status: "DEFERRED",
      total: 2,
      appliedCount: 1,
      deferredCount: 1,
      missingCount: 0,
      retryScheduledCount: 1,
      lagging: 1,
      maxLag: 3,
      totalLag: 3,
    };
    const failures: ProjectionFailureView[] = [
      { project, reason: "DEFERRED", lag: 3, lastError: deferred.lastError, state: deferred },
    ];
    const markup = render(
      createElement(SystemProjectionPanel, {
        client: { projections: { reconcileAll: vi.fn() } } as never,
        summary,
        failures,
      }),
    );

    expect(markup).toContain("全局投影状态");
    expect(markup).toContain("已追平 1");
    expect(markup).toContain("待重试 1");
    expect(markup).toContain("重试全部");
    expect(markup).not.toContain("服务不可用");
  });

  it("invalidates canonical overview/status queries after recovery", async () => {
    const invalidateQueries = vi.fn(async () => undefined);
    await invalidateProjectionQueries({ invalidateQueries } as never);
    expect(invalidateQueries.mock.calls.map(([value]) => value)).toEqual([
      { queryKey: ["overview"] },
      { queryKey: ["status"] },
    ]);
  });
});

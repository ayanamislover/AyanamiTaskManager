import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AyanamiClient } from "@ayanami-task/client";
import { describe, expect, it, vi } from "vitest";
import { GlobalTimelinePage, TimelineEventRow } from "../src/features/timeline.js";

const sourcePath = join(process.cwd(), "packages", "ui", "src", "features", "timeline.tsx");

function client(): AyanamiClient {
  return { overview: vi.fn() } as unknown as AyanamiClient;
}

function renderWithClient(queryClient: QueryClient, child: ReturnType<typeof createElement>) {
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: queryClient }, child));
}

function event(sequence: number, title: string) {
  return {
    sequence,
    type: "work.progressed",
    title,
    detail: `${title}的详情`,
    projectCode: "ATM",
    projectName: "AyanamiTaskManager",
    key: `ATM-T-${sequence.toString().padStart(4, "0")}`,
    actor: "codex-root",
    created_at: "2026-08-28T00:00:00.000Z",
  };
}

function missingTimelineContracts(source: string): string[] {
  const contracts = [
    "presentTimelineEvent(event)",
    'className="atm-event"',
    'className="atm-event-context"',
    'className="atm-event-detail"',
    'className="atm-row-sub atm-event-meta"',
    'queryKey: ["overview"]',
    "queryFn: () => client.overview()",
    "(query.data!.recentEvents ?? [])",
    "<TimelineEventRow event={event} key={item.id} />",
  ];
  return contracts.filter((contract) => !source.includes(contract));
}

describe("Timeline feature", () => {
  it("保持可读事件上下文、详情、类别、actor、序列和时间 DOM", () => {
    const markup = renderToStaticMarkup(
      createElement(TimelineEventRow, { event: event(42, "任务进度") }),
    );

    expect(markup).toContain('class="atm-event"');
    expect(markup).toContain('data-event-type="work.progressed"');
    expect(markup).toContain("AyanamiTaskManager");
    expect(markup).toContain("ATM-T-0042");
    expect(markup).toContain("任务进度的详情");
    expect(markup).toContain("任务进度已更新");
    expect(markup).toContain("codex-root");
    expect(markup).toContain("序列 42");
    expect(markup).toContain('dateTime="2026-08-28T00:00:00.000Z"');
  });

  it("保持全局 overview query 与最近事件展示", () => {
    const globalClient = new QueryClient();
    globalClient.setQueryData(["overview"], { recentEvents: [event(1, "全局事件")] });
    const globalMarkup = renderWithClient(
      globalClient,
      createElement(GlobalTimelinePage, { client: client() }),
    );

    expect(globalMarkup).toContain("全局时间线");
    expect(globalMarkup).toContain("全局事件");
  });

  it("全局 query/展示契约有阳性变异红灯", () => {
    const source = readFileSync(sourcePath, "utf8");
    expect(missingTimelineContracts(source)).toEqual([]);

    for (const contract of [
      "presentTimelineEvent(event)",
      'queryKey: ["overview"]',
      "queryFn: () => client.overview()",
    ]) {
      expect(missingTimelineContracts(source.replaceAll(contract, "MUTATED"))).toContain(contract);
    }
  });
});

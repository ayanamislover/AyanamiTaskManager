import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AyanamiClient } from "@ayanami-task/client";
import { describe, expect, it, vi } from "vitest";
import { GlobalTimelinePage, TimelineEventRow } from "../src/features/timeline.js";
import { isSystemTimelineEvent } from "../src/timeline-events.js";

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
    'className="atm-row-title atm-event-summary"',
    'className="atm-row-sub atm-event-meta"',
    'queryKey: ["overview"]',
    "queryFn: () => client.overview()",
    "(query.data?.recentEvents ?? [])",
    "<TimelineEventRow event={event} key={item.id} />",
  ];
  return contracts.filter((contract) => !source.includes(contract));
}

describe("Timeline feature", () => {
  it("一条事件两行：正文一句话，下面是项目、业务键、谁和时间；不重复类别也不露序列", () => {
    const markup = renderToStaticMarkup(
      createElement(TimelineEventRow, { event: event(42, "任务进度") }),
    );

    expect(markup).toContain('class="atm-event"');
    expect(markup).toContain('data-event-type="work.progressed"');
    expect(markup).toContain("AyanamiTaskManager");
    expect(markup).toContain("ATM-T-0042");
    expect(markup).toContain("任务进度的详情");
    expect(markup).toContain("codex-root");
    expect(markup).toContain('dateTime="2026-08-28T00:00:00.000Z"');
    // 标题「任务进度」和类别「任务进度已更新」都是正文的同义重复。
    expect(markup).not.toContain(">任务进度<");
    expect(markup).not.toContain("任务进度已更新");
    expect(markup).not.toContain("序列");
  });

  it("业务键已经写进正文或是内部 ULID 时不单独重复；系统和桌面用户显示为中文", () => {
    const inDetail = renderToStaticMarkup(
      createElement(TimelineEventRow, {
        event: { ...event(1, "创建任务"), detail: "创建任务 ATM-T-0001「拆分列表」" },
      }),
    );
    expect(inDetail.split("ATM-T-0001")).toHaveLength(2);

    const internal = renderToStaticMarkup(
      createElement(TimelineEventRow, {
        event: {
          ...event(2, "创建目标"),
          key: "01M2HG6KT16MP70BGG36PJTVBN",
          detail: "创建目标「交付桌面体验」",
          actor: "USER",
        },
      }),
    );
    expect(internal).not.toContain("01M2HG6KT16MP70BGG36PJTVBN");
    expect(internal).toContain("桌面用户");
  });

  it("系统事件默认隐藏：自动备份、创建中间步骤、摘要重算、Git 上下文刷新和 SYSTEM 发起的事件", () => {
    const business = event(1, "任务进度");
    const globalClient = new QueryClient();
    globalClient.setQueryData(["overview"], {
      recentEvents: [
        business,
        { ...event(2, "备份"), type: "backup.created", actor: "SYSTEM", detail: "PROJECT 备份" },
        { ...event(3, "Git"), type: "agent.git_context.updated", detail: "Git 上下文刷新了" },
        { ...event(4, "项目"), type: "project.created", actor: "SYSTEM", detail: "系统创建了项目" },
      ],
    });
    const markup = renderWithClient(
      globalClient,
      createElement(GlobalTimelinePage, { client: client() }),
    );
    expect(markup).toContain("任务进度的详情");
    for (const hidden of ["PROJECT 备份", "Git 上下文刷新了", "系统创建了项目"])
      expect(markup).not.toContain(hidden);
    expect(markup).toContain("显示系统事件");
    expect(
      [business, { type: "backup.failed" }, { type: "work.created", actor: "SYSTEM" }].map(
        isSystemTimelineEvent,
      ),
    ).toEqual([false, true, true]);
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

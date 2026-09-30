import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AyanamiClient } from "@ayanami-task/client";
import { describe, expect, it, vi } from "vitest";
import { queriesSettled } from "../src/queries-settled.js";
import { ProgressStripView } from "../src/features/project-progress-strip.js";
import { ProjectSummary } from "../src/features/project-summary.js";

// 切项目时「先留着旧页、读完再换」靠的是这几块：首屏查询都有了结果才算就绪；
// 超时先换上时，进度条占住位置、卡片不先下「没有」「尚未设置」的结论。
// 时序本身在 e2e「侧栏切到没缓存的项目」两条里验。

describe("首屏就绪判定", () => {
  it("每个查询都成功或失败才算就绪；还在读、还没创建都不算", async () => {
    const client = new QueryClient();
    const keys = [
      ["brief", "P"],
      ["tasks", "P", "ui", "open"],
    ] as const;
    expect(queriesSettled(client, keys)).toBe(false);
    client.setQueryData(["brief", "P"], { objective: "x" });
    expect(queriesSettled(client, keys)).toBe(false);
    // 已经开始读、还没回来：查询存在但仍是 pending。
    void client.prefetchQuery({
      queryKey: ["tasks", "P", "ui", "open"],
      queryFn: () => new Promise(() => {}),
    });
    expect(client.getQueryCache().find({ queryKey: ["tasks", "P", "ui", "open"] })).toBeDefined();
    expect(queriesSettled(client, keys)).toBe(false);
    client.removeQueries({ queryKey: ["tasks", "P", "ui", "open"] });
    await client
      .fetchQuery({
        queryKey: ["tasks", "P", "ui", "open"],
        queryFn: () => Promise.reject(new Error("503")),
        retry: false,
      })
      .catch(() => undefined);
    expect(queriesSettled(client, keys)).toBe(true);
  });
});

describe("读取中的占位", () => {
  it("进度条读取中照样渲染同一套结构，数字位是破折号并标 aria-busy", () => {
    const loading = renderToStaticMarkup(createElement(ProgressStripView, { counts: null }));
    const loaded = renderToStaticMarkup(
      createElement(ProgressStripView, {
        counts: { since: "2026-09-29T00:00:00.000Z", done: 1, active: 2, waiting: 0, ready: 1 },
      }),
    );
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain("—<small>本次完成</small>");
    expect(loading).not.toMatch(/<b>\d/u);
    const structure = (markup: string) =>
      [...markup.matchAll(/class="(atm-progress-strip[^"]*)"/gu)].map((match) => match[1]);
    expect(structure(loading)).toEqual(structure(loaded));
  });

  it("任务和 brief 还没读回来时，卡片不说「没有进行中任务」，指标不说「尚未设置」", () => {
    const queryClient = new QueryClient();
    const client = {
      projects: {
        brief: vi.fn(() => new Promise(() => {})),
        agents: vi.fn(() => new Promise(() => {})),
        updates: vi.fn(() => new Promise(() => {})),
      },
      tasks: { progressStripForUi: vi.fn(() => new Promise(() => {})) },
      overview: vi.fn(() => new Promise(() => {})),
    } as unknown as AyanamiClient;
    const markup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(ProjectSummary, {
          client,
          projectCode: "P",
          workItems: [],
          tasksLoading: true,
          openTask: () => {},
        }),
      ),
    );
    for (const claim of [
      "没有进行中任务",
      "没有阻塞",
      "没有 READY 任务",
      "尚未设置",
      "尚无在线",
      "尚无进度",
      "未知",
      "0%",
    ])
      expect(markup).not.toContain(claim);
    expect(markup).toContain("atm-skeleton");
  });

  it("读失败、任务只读到一部分时，卡片也不下「没有」「尚未设置」「尚无」的结论", async () => {
    // 自动重试已经用完、停在失败状态（retryOnMount 关掉，渲染时不当成「马上重读」）。
    const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
    const failed = () => Promise.reject(new Error("503"));
    for (const queryKey of [
      ["brief", "P"],
      ["agents", "P"],
      ["project-updates", "P"],
      ["overview"],
    ])
      await queryClient.prefetchQuery({ queryKey, queryFn: failed, retry: false });
    const client = {
      projects: { brief: vi.fn(failed), agents: vi.fn(failed), updates: vi.fn(failed) },
      tasks: { progressStripForUi: vi.fn(() => new Promise(() => {})) },
      overview: vi.fn(failed),
    } as unknown as AyanamiClient;
    const render = (tasksIncomplete: { reading: boolean; error: boolean } | null) =>
      renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(ProjectSummary, {
            client,
            projectCode: "P",
            // 已读到的一页里只有 READY：过滤后「进行中」「阻塞」为空，但还有页没读成。
            workItems: [{ id: "1", key: "P-T-1", title: "可开始", status: "READY" }],
            tasksIncomplete,
            openTask: () => {},
          }),
        ),
      );
    const markup = render({ reading: false, error: true });
    for (const claim of [
      "<strong>没有进行中任务</strong>",
      "<strong>没有阻塞</strong>",
      "尚未设置",
      "尚无在线 Agent 会话",
      "尚未发布项目更新",
      "尚无进度",
    ])
      expect(markup).not.toContain(claim);
    expect(markup).toContain("读取失败");
    expect(markup).toContain("已读到的部分里没有进行中任务");
    expect(markup).toContain("可开始 1+");
    // 完整读完才下结论（其他块仍读失败，照样不给缺省值）。
    const complete = render(null);
    expect(complete).toContain("<strong>没有进行中任务</strong>");
    expect(complete).toContain("可开始 1<");
    expect(complete).not.toContain("尚未设置");
  });
});

describe("侧栏左上角不再有光晕", () => {
  const css = (file: string) =>
    readFileSync(join(process.cwd(), "packages", "ui", "src", file), "utf8");

  it("logo 方块只有一圈淡描边，不是彩色发光阴影；有图时不垫渐变", () => {
    const shell = css("styles/shell.css");
    const mark = /\.atm-brand-mark \{([^}]*)\}/u.exec(shell)?.[1] ?? "";
    expect(mark).toMatch(/box-shadow: 0 0 0 1px /u);
    expect(mark).not.toMatch(/box-shadow:[^;]*rgb\(/u);
    expect(shell).toMatch(/\.atm-brand-mark:has\(> img\) \{\s*background: transparent;/u);
  });

  it("粉色彩雾的中心不在窗口左上角（那里被侧栏盖住，只从卡片四周透出一圈）", () => {
    const base = css("styles/base.css");
    const aurora = /radial-gradient\(([^)]*?) at ([^,]+), var\(--atm-aurora-a\)/u.exec(base);
    expect(aurora?.[2]).toBeDefined();
    expect(aurora?.[2]).not.toBe("0% 0%");
  });
});

describe("切换窗口里的命令与视图", () => {
  it("首屏等待集合跟着当前视图：记录、时间线只在选中时等", async () => {
    const { firstScreenQueries } = await import("../src/features/project.js");
    const keys = (view: Parameters<typeof firstScreenQueries>[1]) =>
      firstScreenQueries("P", view).map((key) => JSON.stringify(key));
    expect(keys("list")).not.toContain(JSON.stringify(["records", "P"]));
    expect(keys("list")).not.toContain(JSON.stringify(["events", "P"]));
    expect(keys("records")).toContain(JSON.stringify(["records", "P"]));
    expect(keys("timeline")).toContain(JSON.stringify(["events", "P"]));
    // 筛选条只在任务类视图里渲染；记录、时间线下等它的查询会永远等不齐。
    for (const filterBarQuery of ["saved-views", "milestones"]) {
      expect(keys("board")).toContain(JSON.stringify([filterBarQuery, "P"]));
      expect(keys("records")).not.toContain(JSON.stringify([filterBarQuery, "P"]));
      expect(keys("timeline")).not.toContain(JSON.stringify([filterBarQuery, "P"]));
    }
  });

  it("「新建任务」命令只认目标项目；不带项目的旧式事件谁都不认", async () => {
    const { isNewProjectTaskFor, NEW_PROJECT_TASK_EVENT } = await import(
      "../src/hooks/new-project-task.js"
    );
    const forB = new CustomEvent(NEW_PROJECT_TASK_EVENT, { detail: { project: "B" } });
    expect(isNewProjectTaskFor(forB, "B")).toBe(true);
    expect(isNewProjectTaskFor(forB, "A")).toBe(false);
    expect(isNewProjectTaskFor(new Event(NEW_PROJECT_TASK_EVENT), "A")).toBe(false);
  });
});

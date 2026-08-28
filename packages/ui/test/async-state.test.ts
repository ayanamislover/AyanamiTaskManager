import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  CursorLoadStatus,
  Empty,
  ErrorState,
  LoadingRows,
  PageHead,
} from "../src/components/async-state.js";

describe("async state primitives", () => {
  it("保持 loading rows 的 class、默认数量与 inline layout", () => {
    expect(renderToStaticMarkup(createElement(LoadingRows, {}))).toBe(
      '<div class="atm-panel-body" style="display:grid;gap:9px"><div class="atm-skeleton"></div><div class="atm-skeleton"></div><div class="atm-skeleton"></div><div class="atm-skeleton"></div></div>',
    );
    expect(
      renderToStaticMarkup(createElement(LoadingRows, { count: 2 })).match(/atm-skeleton/gu),
    ).toHaveLength(2);
  });

  it("保持 empty/error 的 DOM、文案与 action 位置", () => {
    expect(
      renderToStaticMarkup(
        createElement(Empty, {
          title: "没有任务",
          text: "创建第一项。",
          action: createElement("button", null, "创建"),
        }),
      ),
    ).toBe(
      '<div class="atm-empty"><div><strong>没有任务</strong><div>创建第一项。</div><div style="margin-top:16px"><button>创建</button></div></div></div>',
    );
    expect(renderToStaticMarkup(createElement(ErrorState, { error: new Error("boom") }))).toBe(
      '<div class="atm-error"><div><strong>载入失败</strong><div>boom</div></div></div>',
    );
  });

  it("保持 cursor error/retry 与 live status 文案", () => {
    const retry = vi.fn();
    const errorMarkup = renderToStaticMarkup(
      createElement(CursorLoadStatus, {
        loadedCount: 12,
        hasMore: true,
        error: new Error("boom"),
        onRetry: retry,
      }),
    );
    expect(errorMarkup).toBe(
      '<div class="atm-inline-error" role="alert">已加载 12 项，后续分页加载失败。<button class="atm-button" style="margin-left:8px">重试</button></div>',
    );
    expect(retry).not.toHaveBeenCalled();
    expect(
      renderToStaticMarkup(
        createElement(CursorLoadStatus, { loadedCount: 4, hasMore: true, loading: true }),
      ),
    ).toBe(
      '<div class="atm-row-sub atm-cursor-load-status" role="status" aria-live="polite">已加载 4 项，正在加载后续…</div>',
    );
    expect(
      renderToStaticMarkup(createElement(CursorLoadStatus, { loadedCount: 4, hasMore: false })),
    ).toContain("已加载 4 项，已全部加载");
  });

  it("保持 page head 的标题、描述和 actions 容器", () => {
    expect(
      renderToStaticMarkup(
        createElement(PageHead, {
          title: "项目",
          description: "项目说明",
          actions: createElement("button", null, "新建"),
        }),
      ),
    ).toBe(
      '<header class="atm-page-head"><div><h1>项目</h1><p>项目说明</p></div><div class="atm-actions"><button>新建</button></div></header>',
    );
  });
});

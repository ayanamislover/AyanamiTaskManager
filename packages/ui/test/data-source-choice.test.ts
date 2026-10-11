import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DataSourceChoicePage } from "../src/features/data-source-choice.js";
import type { DataSourceState } from "../src/contracts.js";

function render(source: DataSourceState): string {
  return renderToStaticMarkup(
    createElement(DataSourceChoicePage, { source, choose: async () => undefined }),
  );
}

function conflict(
  cause: Extract<DataSourceState, { state: "SOURCE_CONFLICT" }>["cause"],
  error: string | null = null,
): DataSourceState {
  return {
    state: "SOURCE_CONFLICT",
    cause,
    reason: "the 2.x data cannot be compared: data root: unregistered entry stray.bin",
    since: "2026-10-11T09:00:00.000Z",
    error,
  };
}

/** 一个选项按钮的开标签（`disabled` / `aria-checked` 都在这里）。 */
function option(markup: string, label: string): string {
  const at = markup.indexOf(`<strong>${label}</strong>`);
  expect(at).toBeGreaterThan(0);
  return markup.slice(markup.lastIndexOf("<button", at), at);
}

describe("DataSourceChoicePage（07 §7）", () => {
  it("说明原因、两边都可选、先选一边才能继续，原因原文照样给出", () => {
    const markup = render(conflict("UNREADABLE"));
    expect(markup).toContain("需要选择数据来源");
    expect(markup).toContain("2.x 的数据现在读不出来");
    expect(markup).toContain("Agent 也暂时连不上");
    expect(option(markup, "沿用 3.0")).not.toContain("disabled");
    expect(option(markup, "从 2.x 重新转换")).not.toContain("disabled");
    expect(markup).toContain('role="radiogroup" aria-label="数据来源"');
    expect(markup).toMatch(
      /<button class="atm-button primary" type="button" disabled="">先选一边<\/button>/,
    );
    expect(markup).toContain("unregistered entry stray.bin");
  });

  it("3.0 是从别的数据目录转换来的：沿用不了，只剩重新转换且已选上", () => {
    const markup = render(conflict("OTHER_SOURCE"));
    expect(option(markup, "沿用 3.0")).toContain('disabled=""');
    expect(markup).toContain("沿用不了");
    expect(option(markup, "从 2.x 重新转换")).toContain('aria-checked="true"');
    expect(markup).toContain("从 2.x 重新转换，继续");
  });

  it("2.x 的数据目录不在了：重新转换不可选", () => {
    const markup = render(conflict("LEGACY_GONE"));
    expect(option(markup, "从 2.x 重新转换")).toContain('disabled=""');
    expect(markup).toContain("没有可转换的数据");
    expect(option(markup, "沿用 3.0")).toContain('aria-checked="true"');
  });

  it("上一次的选择没做成：把原因摆在选项下面", () => {
    const markup = render(conflict("CHANGED", "SOURCE_KEEP_UNAVAILABLE: no publication"));
    expect(markup).toContain("转换到 3.0 之后，2.x 的数据又有了修改。");
    expect(markup).toContain("上一次的选择没有做成：SOURCE_KEEP_UNAVAILABLE: no publication");
  });

  it("正在按选择启动：不再给选项", () => {
    const markup = render({ state: "STARTING", choosing: true });
    expect(markup).toContain("正在按你的选择启动");
    expect(markup).not.toContain('role="radiogroup"');
  });
});

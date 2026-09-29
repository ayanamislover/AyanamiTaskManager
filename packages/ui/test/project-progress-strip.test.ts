import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ProgressStripView,
  progressStripSegments,
} from "../src/features/project-progress-strip.js";

const counts = { since: "2026-09-29T00:00:00.000Z", done: 5, active: 5, waiting: 2, ready: 2 };

describe("项目进度条", () => {
  it("只有四段，按数量占比分宽，百分比取已完成占比", () => {
    const segments = progressStripSegments(counts);
    expect(segments.map((segment) => segment.label)).toEqual([
      "已完成",
      "进行中",
      "等你",
      "可开始",
    ]);
    expect(segments.map((segment) => Math.round(segment.percent * 10) / 10)).toEqual([
      35.7, 35.7, 14.3, 14.3,
    ]);
    const markup = renderToStaticMarkup(createElement(ProgressStripView, { counts }));
    expect(markup).toContain("36%<small>本次完成</small>");
    expect(markup.match(/<i /g)).toHaveLength(4);
  });

  it("数量为 0 的段不画，图例仍列全四项；没有任务时不除以零", () => {
    const markup = renderToStaticMarkup(
      createElement(ProgressStripView, { counts: { ...counts, done: 0, waiting: 0 } }),
    );
    expect(markup.match(/<i /g)).toHaveLength(2);
    expect(markup).not.toContain('<i data-segment="done"');
    for (const label of ["已完成", "进行中", "等你", "可开始"]) expect(markup).toContain(label);

    const empty = progressStripSegments({ ...counts, done: 0, active: 0, waiting: 0, ready: 0 });
    expect(empty.every((segment) => segment.percent === 0)).toBe(true);
  });

  it("图例说明口径：已完成只算本次启动以来", () => {
    const markup = renderToStaticMarkup(createElement(ProgressStripView, { counts }));
    expect(markup).toContain("本次 ATM 启动以来");
    expect(markup).toContain('aria-label="已完成 5，进行中 5，等你 2，可开始 2"');
  });

  it("口径说明读屏也读得到，且写明「等你」含受阻、「进行中」含验收中", () => {
    const markup = renderToStaticMarkup(createElement(ProgressStripView, { counts }));
    const describedBy = /aria-describedby="([^"]+)"/u.exec(markup)?.[1];
    expect(describedBy).toBeTruthy();
    const hint = new RegExp(`id="${describedBy}"[^>]*>([^<]+)<`, "u").exec(markup)?.[1];
    expect(hint).toContain("等你含等你回复和受阻");
    expect(hint).toContain("验收中");
  });
});

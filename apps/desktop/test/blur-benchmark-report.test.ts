import { describe, expect, it } from "vitest";
import {
  assertBlurBenchmarkReport,
  compareBlurRows,
  percentile,
  summarizeFrameTimes,
  type BlurBenchmarkReport,
  type BlurBenchmarkRow,
} from "../../../scripts/blur-benchmark-report.js";

const row = (
  width: number,
  height: number,
  blur: "on" | "off",
  samples: number[],
): BlurBenchmarkRow => ({
  viewport: { width, height },
  blur,
  computedTopbarFilter: blur === "on" ? "blur(14px)" : "none",
  computedWindowFilter: blur === "on" ? "blur(16px)" : "none",
  frames: summarizeFrameTimes(samples),
  activity: {
    frameCount: samples.length,
    layoutCount: 0,
    layoutDurationMs: 0,
    recalcStyleCount: 0,
    recalcStyleDurationMs: 0,
    scriptDurationMs: 1,
    taskDurationMs: 2,
  },
});

const report = (rows: BlurBenchmarkRow[]): BlurBenchmarkReport => {
  const comparisons = compareBlurRows(rows);
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-28T00:00:00.000Z",
    durationMs: 10_000,
    thresholdPercent: 20,
    candidate: {
      gitHead: "a".repeat(40),
      gitDirty: false,
      executableSha256: "a".repeat(64),
      asarSha256: "b".repeat(64),
      candidateSha256: "c".repeat(64),
    },
    device: {
      platform: "win32",
      architecture: "x64",
      cpuModel: "fixture",
      logicalCores: 8,
      totalMemoryBytes: 16_000_000_000,
      devicePixelRatio: 1,
      userAgent: "fixture",
      webglVendor: "fixture",
      webglRenderer: "fixture",
    },
    rows,
    comparisons,
    fallbacks: {
      forcedColorsMatched: true,
      forcedColorsTopbarFilter: "none",
      forcedColorsWindowFilter: "none",
      reducedTransparencyMatched: true,
      reducedTransparencyTopbarFilter: "none",
      reducedTransparencyWindowFilter: "none",
    },
    decision: comparisons.some((entry) => entry.thresholdExceeded) ? "DISABLE_BLUR" : "KEEP_BLUR",
  };
};

describe("packaged blur benchmark report", () => {
  it("计算 p50/p95、掉帧与连续掉帧", () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(summarizeFrameTimes([16, 16, 30, 31, 32, 16])).toMatchObject({
      sampleCount: 6,
      droppedFrames: 3,
      maxConsecutiveDroppedFrames: 3,
    });
  });

  it("仅在 p95 增幅超过 20% 或连续三帧掉帧时要求降级", () => {
    const keep = compareBlurRows([
      row(1366, 768, "off", Array(600).fill(16)),
      row(1366, 768, "on", Array(600).fill(18)),
    ]);
    expect(keep[0]).toMatchObject({ thresholdExceeded: false, visibleConsecutiveDrops: false });

    const disable = compareBlurRows([
      row(1366, 768, "off", Array(600).fill(16)),
      row(1366, 768, "on", Array(600).fill(21)),
    ]);
    expect(disable[0]).toMatchObject({ thresholdExceeded: true });
  });

  it("浅层报告必须绑定候选、三视口 A/B 与两种 fallback", () => {
    const rows = [
      row(1366, 768, "off", Array(600).fill(16)),
      row(1366, 768, "on", Array(600).fill(16)),
      row(1920, 1080, "off", Array(600).fill(16)),
      row(1920, 1080, "on", Array(600).fill(16)),
      row(3440, 1440, "off", Array(600).fill(16)),
      row(3440, 1440, "on", Array(600).fill(16)),
    ];
    const valid = report(rows);
    expect(() => assertBlurBenchmarkReport(valid)).not.toThrow();
    expect(() =>
      assertBlurBenchmarkReport({
        ...valid,
        rows: rows.slice(0, 4),
      }),
    ).toThrow(/视口不完整/u);
    expect(() =>
      assertBlurBenchmarkReport({
        ...valid,
        fallbacks: { ...valid.fallbacks, forcedColorsMatched: false },
      }),
    ).toThrow(/fallback/u);
  });
});

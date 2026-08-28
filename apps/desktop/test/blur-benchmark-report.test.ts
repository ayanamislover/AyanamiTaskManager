import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  measurementDurationMs: 10_000,
  rawFrameTimesMs: samples,
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
    compositorEventCount: 1,
    gpuEventCount: 1,
    rasterEventCount: 1,
    tracedDurationMs: 1,
  },
});

const report = (rows: BlurBenchmarkRow[]): BlurBenchmarkReport => {
  const comparisons = compareBlurRows(rows);
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-28T00:00:00.000Z",
    durationMs: 10_000,
    thresholdPercent: 20,
    aggregationMethod:
      "Raw requestAnimationFrame deltas; p50/p95 use linear interpolation; dropped threshold is 1.5x measured median.",
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
      forcedColorsTopbarBackground: "rgb(255, 255, 255)",
      forcedColorsWindowBackground: "rgb(255, 255, 255)",
      reducedTransparencyMatched: true,
      reducedTransparencyTopbarFilter: "none",
      reducedTransparencyWindowFilter: "none",
      reducedTransparencyTopbarBackground: "rgb(255, 255, 255)",
      reducedTransparencyWindowBackground: "rgb(255, 255, 255)",
    },
    decision: comparisons.some((entry) => entry.thresholdExceeded) ? "DISABLE_BLUR" : "KEEP_BLUR",
  };
};

describe("packaged blur benchmark report", () => {
  it("已发布的 b327dec packaged 报告保持可重算并绑定候选", () => {
    const published = JSON.parse(
      readFileSync(
        join(process.cwd(), "output", "performance", "packaged-blur-benchmark.json"),
        "utf8",
      ),
    ) as BlurBenchmarkReport;

    expect(() => assertBlurBenchmarkReport(published)).not.toThrow();
    expect(published.candidate).toMatchObject({
      gitHead: "b327dec47617a8048c26675a110f93fbfeb4cf43",
      candidateSha256: "0c8f3722a91e0d9a590443fa8058edcd406ceb3a3c58aaa18d5f5226360d736a",
      gitDirty: false,
    });
    expect(published.decision).toBe("KEEP_BLUR");
  });

  it("计算 p50/p95、掉帧与连续掉帧", () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(summarizeFrameTimes([16, 16, 30, 31, 32, 16], 25)).toMatchObject({
      sampleCount: 6,
      droppedThresholdMs: 25,
      droppedFrames: 3,
      maxConsecutiveDroppedFrames: 3,
    });
    expect(summarizeFrameTimes([8, 8, 8, 13])).toMatchObject({
      baselineFrameMs: 8,
      droppedThresholdMs: 12,
      droppedFrames: 1,
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
    expect(() =>
      assertBlurBenchmarkReport({
        ...valid,
        rows: [{ ...rows[0]!, measurementDurationMs: 9_999 }, ...rows.slice(1)],
      }),
    ).toThrow(/未测满/u);
    expect(() =>
      assertBlurBenchmarkReport({
        ...valid,
        rows: [
          { ...rows[0]!, rawFrameTimesMs: [...rows[0]!.rawFrameTimesMs, 300] },
          ...rows.slice(1),
        ],
      }),
    ).toThrow(/原始帧/u);
    expect(() =>
      assertBlurBenchmarkReport({
        ...valid,
        fallbacks: { ...valid.fallbacks, forcedColorsTopbarFilter: "blur(14px)" },
      }),
    ).toThrow(/fallback/u);
  });

  it("renderer 采样不得丢弃 >=250ms 的严重长帧", () => {
    const source = readFileSync(
      join(process.cwd(), "scripts", "packaged-blur-benchmark.ts"),
      "utf8",
    );
    expect(source).toContain("if (delta > 0) frameTimes.push(delta);");
    expect(source).not.toMatch(/delta\s*<\s*250/u);
  });
});

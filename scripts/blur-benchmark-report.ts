export type FrameSummary = {
  sampleCount: number;
  baselineFrameMs: number;
  droppedThresholdMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  droppedFrames: number;
  maxConsecutiveDroppedFrames: number;
};

export type BlurBenchmarkRow = {
  viewport: { width: number; height: number };
  blur: "on" | "off";
  measurementDurationMs: number;
  rawFrameTimesMs: number[];
  computedTopbarFilter: string;
  computedWindowFilter: string;
  frames: FrameSummary;
  activity: {
    frameCount: number;
    layoutCount: number;
    layoutDurationMs: number;
    recalcStyleCount: number;
    recalcStyleDurationMs: number;
    scriptDurationMs: number;
    taskDurationMs: number;
    compositorEventCount: number;
    gpuEventCount: number;
    rasterEventCount: number;
    tracedDurationMs: number;
  };
};

export type BlurBenchmarkComparison = {
  viewport: { width: number; height: number };
  p95IncreasePercent: number;
  visibleConsecutiveDrops: boolean;
  thresholdExceeded: boolean;
};

export type BlurBenchmarkReport = {
  schemaVersion: 1;
  generatedAt: string;
  durationMs: number;
  thresholdPercent: number;
  aggregationMethod: string;
  candidate: {
    gitHead: string;
    gitDirty: false;
    executableSha256: string;
    asarSha256: string;
    candidateSha256: string;
  };
  device: {
    platform: string;
    architecture: string;
    cpuModel: string;
    logicalCores: number;
    totalMemoryBytes: number;
    devicePixelRatio: number;
    userAgent: string;
    webglVendor: string;
    webglRenderer: string;
  };
  rows: BlurBenchmarkRow[];
  comparisons: BlurBenchmarkComparison[];
  fallbacks: {
    forcedColorsMatched: boolean;
    forcedColorsTopbarFilter: string;
    forcedColorsWindowFilter: string;
    forcedColorsTopbarBackground: string;
    forcedColorsWindowBackground: string;
    reducedTransparencyMatched: boolean;
    reducedTransparencyTopbarFilter: string;
    reducedTransparencyWindowFilter: string;
    reducedTransparencyTopbarBackground: string;
    reducedTransparencyWindowBackground: string;
  };
  decision: "KEEP_BLUR" | "DISABLE_BLUR";
};

const rounded = (value: number) => Math.round(value * 1_000) / 1_000;

export function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const position = Math.max(0, Math.min(1, quantile)) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return rounded(sorted[lower]! * (1 - weight) + sorted[upper]! * weight);
}

export function summarizeFrameTimes(
  samples: readonly number[],
  droppedThresholdMs?: number,
): FrameSummary {
  const baselineFrameMs = percentile(samples, 0.5);
  const effectiveDroppedThresholdMs =
    droppedThresholdMs ?? (baselineFrameMs > 0 ? baselineFrameMs * 1.5 : 0);
  let droppedFrames = 0;
  let consecutive = 0;
  let maxConsecutiveDroppedFrames = 0;
  for (const sample of samples) {
    if (sample > effectiveDroppedThresholdMs) {
      droppedFrames += 1;
      consecutive += 1;
      maxConsecutiveDroppedFrames = Math.max(maxConsecutiveDroppedFrames, consecutive);
    } else {
      consecutive = 0;
    }
  }
  return {
    sampleCount: samples.length,
    baselineFrameMs,
    droppedThresholdMs: rounded(effectiveDroppedThresholdMs),
    p50Ms: baselineFrameMs,
    p95Ms: percentile(samples, 0.95),
    maxMs: rounded(Math.max(0, ...samples)),
    droppedFrames,
    maxConsecutiveDroppedFrames,
  };
}

export function compareBlurRows(
  rows: readonly BlurBenchmarkRow[],
  thresholdPercent = 20,
): BlurBenchmarkComparison[] {
  const viewports = new Map<string, { width: number; height: number }>();
  for (const row of rows)
    viewports.set(`${row.viewport.width}x${row.viewport.height}`, row.viewport);
  return [...viewports.values()].map((viewport) => {
    const matching = rows.filter(
      (row) => row.viewport.width === viewport.width && row.viewport.height === viewport.height,
    );
    const on = matching.find((row) => row.blur === "on");
    const off = matching.find((row) => row.blur === "off");
    if (!on || !off)
      throw new Error(`视口缺少 blur-on/off 配对：${viewport.width}x${viewport.height}`);
    const p95IncreasePercent =
      off.frames.p95Ms <= 0
        ? 0
        : rounded(((on.frames.p95Ms - off.frames.p95Ms) / off.frames.p95Ms) * 100);
    const visibleConsecutiveDrops = on.frames.maxConsecutiveDroppedFrames >= 3;
    return {
      viewport,
      p95IncreasePercent,
      visibleConsecutiveDrops,
      thresholdExceeded: p95IncreasePercent > thresholdPercent || visibleConsecutiveDrops,
    };
  });
}

export function assertBlurBenchmarkReport(report: BlurBenchmarkReport): void {
  if (report.schemaVersion !== 1) throw new Error("blur benchmark schemaVersion 必须为 1");
  if (report.durationMs < 10_000) throw new Error("每种模式必须至少连续测量 10 秒");
  if (!report.aggregationMethod.includes("requestAnimationFrame")) {
    throw new Error("性能报告缺少可审计聚合方法");
  }
  if (report.candidate.gitDirty !== false) throw new Error("性能候选必须来自 clean Git tree");
  for (const hash of [
    report.candidate.executableSha256,
    report.candidate.asarSha256,
    report.candidate.candidateSha256,
  ]) {
    if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error("候选 hash 非法");
  }
  const expectedViewports = ["1366x768", "1920x1080", "3440x1440"];
  const actualViewports = [
    ...new Set(report.rows.map((row) => `${row.viewport.width}x${row.viewport.height}`)),
  ].sort();
  if (JSON.stringify(actualViewports) !== JSON.stringify(expectedViewports.sort())) {
    throw new Error(`性能报告视口不完整：${actualViewports.join(",")}`);
  }
  if (report.rows.length !== 6 || report.comparisons.length !== 3) {
    throw new Error("性能报告必须包含三视口各一组 blur-on/off");
  }
  for (const row of report.rows) {
    if (row.measurementDurationMs < report.durationMs) {
      throw new Error("性能报告存在未测满时长的 A/B 组");
    }
    if (row.rawFrameTimesMs.length !== row.frames.sampleCount || row.frames.sampleCount < 300) {
      throw new Error("性能报告原始帧样本缺失或不足");
    }
    if (row.rawFrameTimesMs.some((sample) => !Number.isFinite(sample) || sample <= 0)) {
      throw new Error("性能报告包含非法帧样本");
    }
    const recomputed = summarizeFrameTimes(row.rawFrameTimesMs);
    if (JSON.stringify(recomputed) !== JSON.stringify(row.frames)) {
      throw new Error("性能报告帧聚合与原始样本不一致");
    }
    if (row.blur === "on") {
      if (
        !row.computedTopbarFilter.includes("blur") ||
        !row.computedWindowFilter.includes("blur")
      ) {
        throw new Error("blur-on 组未命中真实材质");
      }
    } else if (row.computedTopbarFilter !== "none" || row.computedWindowFilter !== "none") {
      throw new Error("blur-off 组未关闭真实材质");
    }
    if (
      row.activity.compositorEventCount +
        row.activity.gpuEventCount +
        row.activity.rasterEventCount <=
      0
    ) {
      throw new Error("性能报告缺少 GPU/compositor trace activity");
    }
  }
  const fallbackFilters = [
    report.fallbacks.forcedColorsTopbarFilter,
    report.fallbacks.forcedColorsWindowFilter,
    report.fallbacks.reducedTransparencyTopbarFilter,
    report.fallbacks.reducedTransparencyWindowFilter,
  ];
  const fallbackBackgrounds = [
    report.fallbacks.forcedColorsTopbarBackground,
    report.fallbacks.forcedColorsWindowBackground,
    report.fallbacks.reducedTransparencyTopbarBackground,
    report.fallbacks.reducedTransparencyWindowBackground,
  ];
  if (
    !report.fallbacks.forcedColorsMatched ||
    !report.fallbacks.reducedTransparencyMatched ||
    fallbackFilters.some((filter) => filter !== "none") ||
    fallbackBackgrounds.some(
      (background) => background === "transparent" || background === "rgba(0, 0, 0, 0)",
    )
  ) {
    throw new Error("forced-colors/reduced-transparency 运行时 fallback 未命中");
  }
  const recomputedComparisons = compareBlurRows(report.rows, report.thresholdPercent);
  if (JSON.stringify(recomputedComparisons) !== JSON.stringify(report.comparisons)) {
    throw new Error("性能报告 A/B 比较与原始数据不一致");
  }
  const expectedDecision = recomputedComparisons.some((entry) => entry.thresholdExceeded)
    ? "DISABLE_BLUR"
    : "KEEP_BLUR";
  if (report.decision !== expectedDecision) throw new Error("性能决定与阈值结果不一致");
}

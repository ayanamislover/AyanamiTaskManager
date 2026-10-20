/**
 * 3.0 预算验收线（ATM 3 规格 08 §3）逐条对实测。budget-measure 写进报告的 summary.verdicts，
 * assemble-release 只认全部达标的报告——预算不放宽，除非用户同意。
 */
const MIB = 1024 * 1024;

export const BUDGET = {
  payloadBytes: 20 * MIB,
  updateZipBytes: 10 * MIB,
  conversionMs: 60_000,
  idlePrivate: 40 * MIB,
  agentPrivate: 60 * MIB,
  // 关窗后两条于 2026-10-12 经用户同意修订（ATM-D-492）：开窗时 Windows 往主进程加载的 IME/TSF、
  // D2D/DWrite/D3D11/DComp 与 WebView2 嵌入层关窗后不卸载。原线是 +15 MiB、末轮 ≤ 第 1 轮 + 5 MiB。
  closedOverIdle: 50 * MIB,
  closedDrift: 5 * MIB,
  backgroundHealthMs: 500,
  windowVisibleMs: 1_200,
} as const;

/**
 * 08 §1：内存各场景、关开窗轮数与冷启动都量 5 次（ATM-D-519：关开窗保持 5 轮）。少于这个数的报告只能当诊断看：
 * 对应那一项判不达标，组装与发布也就不认（W8 关口 peer r1 P2-02）。
 */
export const MIN_SAMPLES = 5;

/** 08 §3 的全部验收项，按 {@link budgetVerdicts} 的顺序。报告里必须一条不少、一条不多。 */
export const BUDGET_ITEMS = [
  "payload",
  "更新 zip",
  "首次转换（样本库）",
  "后台空闲 Private",
  "Agent 负载后 Private",
  "关窗后 Private",
  "关开窗不上涨",
  "关窗后 WebView2 全部退出",
  "冷启动 · 后台健康（中位）",
  "冷启动 · 窗口可见（中位）",
] as const;

/** 每一项至少要几个样本：体积与首次转换各量一次就是全部，其余按 {@link MIN_SAMPLES}。 */
export function requiredSamples(item: string): number {
  return item === "payload" || item === "更新 zip" || item === "首次转换（样本库）"
    ? 1
    : MIN_SAMPLES;
}

export type Verdict = {
  item: string;
  budget: string;
  /** MiB 或毫秒；没量到是 null。 */
  measured: number | null;
  samples: number;
  pass: boolean;
};

type Median = { median: { hostPrivate: number; totalPrivate: number } };

export type VerdictInput = {
  sizes: { payloadBytes: number; updateZipBytes: number };
  conversion?: { healthMs: number; converted: boolean; progress: unknown[] } | undefined;
  memory?:
    | {
        idle: Median;
        afterAgent: Median;
        cycles: Array<{ closed: Median; webviewGoneMs: number }>;
      }
    | undefined;
  foreground: Array<{ windowVisibleMs: number | null }>;
  background: Array<{ healthMs: number }>;
};

const mib = (bytes: number) => Number((bytes / MIB).toFixed(2));

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** 中位数、最大值与样本数（08 §1：冷启动报中位数与最大值）；没量到的不算样本。 */
export function stats(values: Array<number | null | undefined>) {
  const present = values.filter((value): value is number => typeof value === "number");
  return {
    median: median(present),
    max: present.length === 0 ? null : Math.max(...present),
    samples: present.length,
  };
}

export function budgetVerdicts(input: VerdictInput, samplesPerScene = 5): Verdict[] {
  const verdicts: Verdict[] = [];
  const line = (
    item: string,
    budget: string,
    measured: number | null,
    samples: number,
    pass: boolean,
  ) =>
    verdicts.push({
      item,
      budget,
      measured,
      samples,
      pass: pass && samples >= requiredSamples(item),
    });

  line(
    "payload",
    "≤ 20 MiB",
    mib(input.sizes.payloadBytes),
    1,
    input.sizes.payloadBytes <= BUDGET.payloadBytes,
  );
  line(
    "更新 zip",
    "≤ 10 MiB",
    mib(input.sizes.updateZipBytes),
    1,
    input.sizes.updateZipBytes <= BUDGET.updateZipBytes,
  );

  const conversion = input.conversion;
  line(
    "首次转换（样本库）",
    "≤ 60 s，并且有进度",
    conversion?.healthMs ?? null,
    conversion ? 1 : 0,
    conversion !== undefined &&
      conversion.converted &&
      conversion.healthMs <= BUDGET.conversionMs &&
      // 「有进度」：至少推进过两次，不是只写了一个起点。
      conversion.progress.length >= 2,
  );

  const memory = input.memory;
  const idle = memory?.idle.median.hostPrivate ?? null;
  line(
    "后台空闲 Private",
    "≤ 40 MiB",
    idle === null ? null : mib(idle),
    memory ? samplesPerScene : 0,
    idle !== null && idle <= BUDGET.idlePrivate,
  );
  const agent = memory?.afterAgent.median.hostPrivate ?? null;
  line(
    "Agent 负载后 Private",
    "≤ 60 MiB",
    agent === null ? null : mib(agent),
    memory ? samplesPerScene : 0,
    agent !== null && agent <= BUDGET.agentPrivate,
  );

  // 关窗后量整棵树：WebView2 已经全部退出，剩下的就是主进程（有残留的话也一起算进来）。
  const closed = (memory?.cycles ?? []).map((cycle) => cycle.closed.median.totalPrivate);
  const closedMax = closed.length === 0 ? null : Math.max(...closed);
  line(
    "关窗后 Private",
    "每轮 ≤ 后台空闲 + 50 MiB",
    closedMax === null ? null : mib(closedMax),
    closed.length,
    idle !== null &&
      closed.length > 0 &&
      closed.every((value) => value <= idle + BUDGET.closedOverIdle),
  );
  // 前两轮是系统组件（IME、DirectX、WebView2 嵌入层）加载进主进程，不作基线：从第 3 轮起看是否还在涨
  // （ATM-D-492；W8 关口实测加载到第 3 轮才完，ATM-D-519）。
  const base = closed[2];
  const last = closed.at(-1);
  line(
    "关开窗不上涨",
    "最后一轮 ≤ 第 3 轮 + 5 MiB",
    base === undefined || last === undefined ? null : mib(last - base),
    closed.length,
    base !== undefined && last !== undefined && last <= base + BUDGET.closedDrift,
  );
  const gone = (memory?.cycles ?? []).map((cycle) => cycle.webviewGoneMs);
  line(
    "关窗后 WebView2 全部退出",
    "每轮都退干净",
    gone.length === 0 ? null : Math.max(...gone),
    gone.length,
    gone.length > 0 && gone.every((value) => Number.isFinite(value) && value >= 0),
  );

  const background = stats(input.background.map((run) => run.healthMs));
  line(
    "冷启动 · 后台健康（中位）",
    "≤ 500 ms（不含首次转换）",
    background.median,
    background.samples,
    background.median !== null && background.median <= BUDGET.backgroundHealthMs,
  );
  const visible = stats(input.foreground.map((run) => run.windowVisibleMs));
  line(
    "冷启动 · 窗口可见（中位）",
    "≤ 1200 ms",
    visible.median,
    visible.samples,
    visible.median !== null && visible.median <= BUDGET.windowVisibleMs,
  );
  return verdicts;
}

export type BudgetReport = {
  error?: string;
  completedAt?: string;
  summary?: {
    allPass?: boolean;
    verdicts?: Array<{ item?: string; pass?: boolean; samples?: number }>;
  };
};

/**
 * 预算报告不能用于发布的原因；空数组才放行（assemble-release 用它，publish-verified-release.mjs 照同样的规则复核）。
 * 不只看 `allPass`：验收项一条不少、按顺序，每条都达标，样本数够（W8 关口 peer r1 P2-02）。
 */
export function budgetReportProblems(report: BudgetReport): string[] {
  const problems: string[] = [];
  if (report.error !== undefined) problems.push(`error: ${String(report.error)}`);
  if (typeof report.completedAt !== "string") problems.push("not completed");
  const verdicts = report.summary?.verdicts ?? [];
  const items = verdicts.map((verdict) => verdict.item);
  if (items.length !== BUDGET_ITEMS.length || BUDGET_ITEMS.some((item, i) => items[i] !== item))
    problems.push(`items ${JSON.stringify(items)} are not the 08 §3 list`);
  for (const verdict of verdicts) {
    if (verdict.pass !== true) problems.push(`${String(verdict.item)} does not pass`);
    const need = requiredSamples(String(verdict.item));
    if (!(typeof verdict.samples === "number" && verdict.samples >= need))
      problems.push(
        `${String(verdict.item)} has ${String(verdict.samples)} samples, needs ${need}`,
      );
  }
  if (report.summary?.allPass !== true || verdicts.some((verdict) => verdict.pass !== true))
    problems.push("allPass is not true for every item");
  return problems;
}

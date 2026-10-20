import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUDGET,
  BUDGET_ITEMS,
  budgetReportProblems,
  budgetVerdicts,
  MIN_SAMPLES,
  stats,
  type VerdictInput,
} from "../../../scripts/budget-verdicts.js";

// ATM 3 规格 08 §3 的验收线。每一条都对应一种「量了却没量对」的穿法：W8d-5 的第一版报告把每轮
// 冷启动都量成了首次转换（约 13 s），Agent 负载打的是 2.x 的路由、拿 404 的空回包量内存。
const MIB = 1024 * 1024;
const series = (privateBytes: number) => ({
  median: { hostPrivate: privateBytes, totalPrivate: privateBytes },
});

function passing(): VerdictInput {
  return {
    sizes: { payloadBytes: 16 * MIB, updateZipBytes: 8 * MIB },
    conversion: {
      healthMs: 12_000,
      converted: true,
      progress: [{ phase: "SNAPSHOT" }, { phase: "IMPORT" }, { phase: "PUBLISHED" }],
    },
    memory: {
      idle: series(10 * MIB),
      afterAgent: series(12 * MIB),
      cycles: [1, 2, 3, 4, 5].map((round) => ({
        closed: series((14 + round * 0.5) * MIB),
        webviewGoneMs: 300,
      })),
    },
    foreground: [900, 950, 1000, 1100, 3000].map((ms) => ({ windowVisibleMs: ms })),
    background: [200, 210, 220, 230, 900].map((ms) => ({ healthMs: ms })),
  };
}

const failing = (input: VerdictInput) =>
  budgetVerdicts(input)
    .filter((verdict) => !verdict.pass)
    .map((verdict) => verdict.item);

describe("预算判定（08 §3）", () => {
  // 验收线就是 08 §3 写的那几个数：放宽只能由用户同意后改规格，再改这里。
  it("验收线与规格一致", () => {
    expect(BUDGET).toEqual({
      payloadBytes: 20 * MIB,
      updateZipBytes: 10 * MIB,
      conversionMs: 60_000,
      idlePrivate: 40 * MIB,
      agentPrivate: 60 * MIB,
      closedOverIdle: 50 * MIB,
      closedDrift: 5 * MIB,
      backgroundHealthMs: 500,
      windowVisibleMs: 1_200,
    });
  });

  it("全部达标时每条都过，样本数照实写", () => {
    const verdicts = budgetVerdicts(passing());
    expect(verdicts.every((verdict) => verdict.pass)).toBe(true);
    expect(verdicts.map((verdict) => verdict.item)).toEqual([
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
    ]);
    const byItem = Object.fromEntries(verdicts.map((verdict) => [verdict.item, verdict]));
    expect(byItem["冷启动 · 后台健康（中位）"]).toMatchObject({ measured: 220, samples: 5 });
    expect(byItem["冷启动 · 窗口可见（中位）"]).toMatchObject({ measured: 1000, samples: 5 });
    // 16.5 − 第 3 轮的 15.5。
    expect(byItem["关开窗不上涨"]!.measured).toBe(1);
  });

  it("中位数不被一轮慢的拖过线，但中位数本身过线就红", () => {
    const input = passing();
    input.background = [400, 450, 501, 600, 700].map((ms) => ({ healthMs: ms }));
    expect(failing(input)).toEqual(["冷启动 · 后台健康（中位）"]);
    input.background = [100, 100, 100, 9_000, 9_000].map((ms) => ({ healthMs: ms }));
    expect(failing(input)).toEqual([]);
  });

  it("体积、转换、内存每一条越线都点名", () => {
    const cases: Array<[string, (input: VerdictInput) => void]> = [
      ["payload", (input) => (input.sizes.payloadBytes = BUDGET.payloadBytes + 1)],
      ["更新 zip", (input) => (input.sizes.updateZipBytes = BUDGET.updateZipBytes + 1)],
      ["首次转换（样本库）", (input) => (input.conversion!.healthMs = 60_001)],
      ["首次转换（样本库）", (input) => (input.conversion!.progress = [{ phase: "SNAPSHOT" }])],
      ["首次转换（样本库）", (input) => (input.conversion!.converted = false)],
      ["后台空闲 Private", (input) => (input.memory!.idle = series(41 * MIB))],
      ["Agent 负载后 Private", (input) => (input.memory!.afterAgent = series(61 * MIB))],
      [
        "冷启动 · 窗口可见（中位）",
        (input) =>
          (input.foreground = [900, 1201, 1300, 1400, 3000].map((ms) => ({ windowVisibleMs: ms }))),
      ],
    ];
    for (const [item, mutate] of cases) {
      const input = passing();
      mutate(input);
      expect(failing(input), item).toContain(item);
    }
  });

  const closedCycles = (values: number[]) =>
    values.map((value) => ({ closed: series(value * MIB), webviewGoneMs: 300 }));

  it("关窗后高出空闲 50 MiB 以上、或第 3 轮起涨超过 5 MiB，都红", () => {
    const high = passing();
    high.memory!.cycles[3]!.closed = series(61 * MIB);
    expect(failing(high)).toContain("关窗后 Private");
    const drift = passing();
    drift.memory!.cycles = closedCycles([10, 12, 14, 17, 20]);
    expect(failing(drift)).toEqual(["关开窗不上涨"]);
    // 恰好 +5 MiB 还算达标，多一点就红。
    drift.memory!.cycles = closedCycles([10, 12, 14, 16, 19]);
    expect(failing(drift)).toEqual([]);
    drift.memory!.cycles = closedCycles([10, 12, 14, 16, 19.01]);
    expect(failing(drift)).toEqual(["关开窗不上涨"]);
  });

  // ATM-D-492 / ATM-D-519：前两轮是系统组件（IME、DirectX、WebView2 嵌入层）加载进主进程，不作基线。
  it("前两轮的跳升不算上涨，之后持平就达标", () => {
    const input = passing();
    input.memory!.cycles = closedCycles([48.2, 53.9, 53.7, 52.0, 53.8]);
    input.memory!.idle = series(7.6 * MIB);
    expect(failing(input)).toEqual([]);
    // W8 关口第 2 次完整发布链：组件到第 3 轮才加载完，第 2 轮作基线时 +5.39 MiB 判红。
    input.memory!.cycles = closedCycles([46.04, 49.11, 54.42, 54.39, 54.5]);
    expect(failing(input)).toEqual([]);
    // 只有三轮时看不出第 3 轮之后的趋势，三条关窗的项也都样本不足：不算达标。
    input.memory!.cycles = closedCycles([48.2, 53.9, 53.7]);
    expect(failing(input)).toEqual(["关窗后 Private", "关开窗不上涨", "关窗后 WebView2 全部退出"]);
  });

  // W8 关口 peer r1 P2-02：--cycles / --cold-runs 缩短的测量只能当诊断看，样本不足的项判不达标。
  it("样本不足 5 个的项不算达标", () => {
    expect(MIN_SAMPLES).toBe(5);
    const rounds = passing();
    rounds.memory!.cycles = rounds.memory!.cycles.slice(0, 4);
    expect(failing(rounds)).toEqual(["关窗后 Private", "关开窗不上涨", "关窗后 WebView2 全部退出"]);
    const cold = passing();
    cold.background = cold.background.slice(0, 4);
    cold.foreground = cold.foreground.slice(0, 1);
    expect(failing(cold)).toEqual(["冷启动 · 后台健康（中位）", "冷启动 · 窗口可见（中位）"]);
    expect(
      budgetVerdicts(passing(), 3)
        .filter((verdict) => !verdict.pass)
        .map((verdict) => verdict.item),
    ).toEqual(["后台空闲 Private", "Agent 负载后 Private"]);
  });

  it("没量到就不算达标：缺转换、缺内存、缺冷启动样本都红", () => {
    const none = passing();
    none.conversion = undefined;
    none.memory = undefined;
    none.foreground = [];
    none.background = [];
    expect(failing(none)).toEqual([
      "首次转换（样本库）",
      "后台空闲 Private",
      "Agent 负载后 Private",
      "关窗后 Private",
      "关开窗不上涨",
      "关窗后 WebView2 全部退出",
      "冷启动 · 后台健康（中位）",
      "冷启动 · 窗口可见（中位）",
    ]);
    // 窗口可见没量到（后台启动的那几轮写的是 null）不算样本。
    expect(stats([null, 1_000, undefined, 3_000])).toEqual({
      median: 2_000,
      max: 3_000,
      samples: 2,
    });
  });
});

describe("budget-measure 按 08 的口径量", () => {
  const source = readFileSync(join(process.cwd(), "scripts", "budget-measure.ts"), "utf8");

  it("首次转换只量一次；冷启动与内存都从转换后的快照开始", () => {
    // 只有首次转换那一处用样本副本（N 空着）；其余都从快照开始。
    expect(source.match(/^\s+freshRunData\(\);$/gmu)).toHaveLength(1);
    const main = source.slice(source.indexOf("const probe = new ProcessProbe();"));
    expect(main.indexOf("conversion = await firstConversion(production, probe);")).toBeLessThan(
      main.indexOf("snapshotConverted();"),
    );
    expect(main.indexOf("snapshotConverted();")).toBeLessThan(
      main.indexOf("memory = await measureMemory("),
    );
    expect(main.match(/convertedRunData\(true\);/gu)).toHaveLength(3);
    expect(source).toMatch(/async function measureMemory\([^)]*\) \{\s+convertedRunData\(\);/u);
  });

  it("首次转换记录 startup-progress.json 的每一次推进", () => {
    expect(source).toContain(
      'const progressPath = join(v3Dir, "runtime", "startup-progress.json");',
    );
    expect(source).toContain("if (key !== last) {");
  });

  it("Agent 负载走 3.x 路由、深分页按 cursor 翻，任何一个不是 200 都不算", () => {
    const load = source.slice(
      source.indexOf("async function agentLoad("),
      source.indexOf("async function measureMemory("),
    );
    expect(load).not.toContain("/api/v1/overview");
    expect(load).not.toMatch(/offset=/u);
    expect(load).toContain("if (response.status !== 200)");
    expect(load).toContain("cursor=${encodeURIComponent(cursor)}");
    expect(load).toContain('"/api/v1/projects/PFM/brief"');
  });

  it("每个场景 5 个样本；不达标以退出码 1 结束", () => {
    expect(source).toContain("const SAMPLES = 5;");
    expect(source).not.toMatch(/sampleSeries\(probe, host\.pid, \d/u);
    expect(source).toMatch(/failedVerdicts\.length > 0\) \{[\s\S]{0,200}process\.exitCode = 1;/u);
  });

  it("组装与发布入口只认十条全部达标、样本数够的报告", () => {
    const assemble = readFileSync(join(process.cwd(), "scripts", "assemble-release.ts"), "utf8");
    expect(assemble).toMatch(
      /const budgetProblems = budgetReportProblems\(budget\);\s+if \(budgetProblems\.length > 0\)\s+throw new Error\(`BUDGET_REPORT_INPUT_FAILED: /u,
    );
    const publish = readFileSync(
      join(process.cwd(), ".github", "scripts", "publish-verified-release.mjs"),
      "utf8",
    );
    expect(publish).toContain("assert.equal(budget.summary?.allPass, true);");
    // 发布入口不能 import TS，照同一份清单另写一遍：清单与这里的 BUDGET_ITEMS 一字不差。
    const list = /const BUDGET_ITEMS = \[([\s\S]*?)\];/u.exec(publish)?.[1] ?? "";
    expect([...list.matchAll(/"([^"]+)"/gu)].map((match) => match[1])).toEqual([...BUDGET_ITEMS]);
    expect(publish).toContain(
      "budget.summary.verdicts.map((verdict) => verdict.item),\n  BUDGET_ITEMS,",
    );
    expect(publish).toContain("assert.equal(verdict.pass, true, verdict.item);");
    expect(publish).toContain(
      "assert.ok(verdict.samples >= (ONE_SAMPLE.has(verdict.item) ? 1 : 5), verdict.item);",
    );
  });

  describe("budgetReportProblems", () => {
    const report = () => ({
      completedAt: "2026-10-12T00:00:00.000Z",
      summary: { allPass: true, verdicts: budgetVerdicts(passing()) },
    });

    it("全部达标的完整报告放行", () => {
      expect(budgetReportProblems(report())).toEqual([]);
    });

    it("allPass 写成 true、某一条却没过：拒绝", () => {
      const r = report();
      r.summary.verdicts[6]!.pass = false;
      expect(budgetReportProblems(r).join(" | ")).toContain("关开窗不上涨 does not pass");
    });

    it("少一条、多一条、换了顺序：拒绝", () => {
      const fewer = report();
      fewer.summary.verdicts.pop();
      expect(budgetReportProblems(fewer).join(" | ")).toContain("are not the 08 §3 list");
      const more = report();
      more.summary.verdicts.push({ ...more.summary.verdicts[0]!, item: "多出来的" });
      expect(budgetReportProblems(more).join(" | ")).toContain("are not the 08 §3 list");
      const swapped = report();
      swapped.summary.verdicts.reverse();
      expect(budgetReportProblems(swapped).join(" | ")).toContain("are not the 08 §3 list");
    });

    it("样本数不够：拒绝（即使那一条写着 pass）", () => {
      const r = report();
      r.summary.verdicts[8]!.samples = 3;
      expect(budgetReportProblems(r).join(" | ")).toContain(
        "冷启动 · 后台健康（中位） has 3 samples, needs 5",
      );
    });

    it("出错或没写完：拒绝", () => {
      expect(budgetReportProblems({ ...report(), error: "boom" }).join(" | ")).toContain(
        "error: boom",
      );
      const unfinished: { completedAt?: string } = report();
      delete unfinished.completedAt;
      expect(budgetReportProblems(unfinished)).toContain("not completed");
    });
  });

  it("导出大项目之后的场景经界面 bridge 导出主项目", () => {
    expect(source).toContain('"/api/v1/exports/PFM"');
    expect(source).toContain("const exported = await measureExport(smoke, probe, nativeWindows);");
  });
});

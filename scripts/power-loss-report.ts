/**
 * 掉电演练（power-loss-drill.ts）报告的验收判定（W8f）。assemble-release 只认这里放行的报告：
 * 三个场景都跑过（`--only` 跑出的部分报告不算）、每一项都通过、没有中途异常。候选绑定另由
 * candidate-binaries.ts 对 `binaries`。
 */

/** 演练的全部场景，按执行顺序。 */
export const POWER_LOSS_SCENARIOS = ["conversion", "writes", "recover"] as const;
export type PowerLossScenario = (typeof POWER_LOSS_SCENARIOS)[number];

export type PowerLossReport = {
  passed?: boolean;
  total?: number;
  failed?: number;
  error?: string | null;
  /** 这一次实际跑了哪些场景。 */
  scenarios?: string[];
  checks?: Array<{ scenario?: string; name?: string; passed?: boolean }>;
};

/** 报告不能用的原因；空数组才放行。 */
export function powerLossReportProblems(report: PowerLossReport): string[] {
  const problems: string[] = [];
  const checks = report.checks ?? [];
  if (report.passed !== true) problems.push("passed is not true");
  if (report.error !== null) problems.push(`error: ${String(report.error)}`);
  if (report.failed !== 0) problems.push(`failed: ${String(report.failed)}`);
  if (!(checks.length > 0) || report.total !== checks.length)
    problems.push(`total ${String(report.total)} does not match ${checks.length} checks`);
  const failing = checks.filter((check) => check.passed !== true);
  if (failing.length > 0)
    problems.push(`failing checks: ${failing.map((check) => String(check.name)).join("; ")}`);
  const ran = report.scenarios ?? [];
  if (
    ran.length !== POWER_LOSS_SCENARIOS.length ||
    POWER_LOSS_SCENARIOS.some((s, i) => ran[i] !== s)
  )
    problems.push(`scenarios ${JSON.stringify(ran)} are not ${POWER_LOSS_SCENARIOS.join(",")}`);
  for (const scenario of POWER_LOSS_SCENARIOS)
    if (!checks.some((check) => check.scenario === scenario))
      problems.push(`no checks for ${scenario}`);
  return problems;
}

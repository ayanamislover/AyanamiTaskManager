import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  POWER_LOSS_SCENARIOS,
  powerLossReportProblems,
  type PowerLossReport,
} from "../../../scripts/power-loss-report.js";

const read = (...path: string[]) => readFileSync(join(process.cwd(), ...path), "utf8");

function goodReport(): PowerLossReport {
  const checks = POWER_LOSS_SCENARIOS.flatMap((scenario) => [
    { scenario, name: `${scenario} 1`, passed: true },
    { scenario, name: `${scenario} 2`, passed: true },
  ]);
  return {
    passed: true,
    total: checks.length,
    failed: 0,
    error: null,
    scenarios: [...POWER_LOSS_SCENARIOS],
    checks,
  };
}

describe("掉电演练报告的验收（W8f，power-loss-report.ts）", () => {
  it("三个场景都跑过、每项通过才放行", () => {
    expect(POWER_LOSS_SCENARIOS).toEqual(["conversion", "writes", "recover"]);
    expect(powerLossReportProblems(goodReport())).toEqual([]);
  });

  it("每一种不完整都点名拒绝", () => {
    const cases: Array<[RegExp, (report: PowerLossReport) => void]> = [
      [/^passed is not true$/u, (r) => (r.passed = false)],
      [/^error: boom$/u, (r) => (r.error = "boom")],
      // 旧报告没有 error 字段：不当作没出错。
      [/^error: undefined$/u, (r) => delete r.error],
      [/^failed: 1$/u, (r) => (r.failed = 1)],
      [/^total 5 does not match 6 checks$/u, (r) => (r.total = 5)],
      [/^failing checks: writes 2$/u, (r) => (r.checks![3]!.passed = false)],
      // `--only recover` 跑出的部分报告。
      [/^scenarios \["recover"\] are not/u, (r) => (r.scenarios = ["recover"])],
      [
        /^scenarios \["writes","conversion","recover"\] are not/u,
        (r) => (r.scenarios = ["writes", "conversion", "recover"]),
      ],
      [/^scenarios \[\] are not/u, (r) => delete r.scenarios],
    ];
    for (const [expected, mutate] of cases) {
      const report = goodReport();
      mutate(report);
      const problems = powerLossReportProblems(report);
      expect(problems, String(expected)).toHaveLength(1);
      expect(problems[0], String(expected)).toMatch(expected);
    }
    // 声称跑过、却一项都没留下的场景。
    const silent = goodReport();
    silent.checks = silent.checks!.filter((check) => check.scenario !== "writes");
    silent.total = silent.checks.length;
    expect(powerLossReportProblems(silent)).toEqual(["no checks for writes"]);
    const empty = goodReport();
    empty.checks = [];
    empty.total = 0;
    expect(powerLossReportProblems(empty)).toContain("total 0 does not match 0 checks");
  });
});

describe("掉电演练本身（scripts/power-loss-drill.ts）", () => {
  const drill = read("scripts", "power-loss-drill.ts");

  it("真掉电：TerminateProcess，不给收尾的机会", () => {
    const body = drill.slice(
      drill.indexOf("async function powerCut("),
      drill.indexOf("async function healthy("),
    );
    expect(body).toContain('host.child.kill("SIGKILL");');
  });

  it("全部在 output/ 下的合成根上", () => {
    for (const name of ["power-loss", "budget-seed-data", "power-loss-portable"])
      expect(drill).toContain(`assertSandboxDataDir(join(outputRoot, "${name}"))`);
  });

  it("转换在五个阶段各杀一次，哪个阶段没赶上就不通过", () => {
    const points = drill.slice(drill.indexOf("const CUT_POINTS"), drill.indexOf("type Reference"));
    expect([...points.matchAll(/name: "([A-Z]+)"/gu)].map((match) => match[1])).toEqual([
      "SNAPSHOT",
      "IMPORT",
      "VERIFY",
      "PUBLISHING",
      "PUBLISHED",
    ]);
    expect(points).toContain("p.done * 2 >= p.total");
    expect(drill).toContain("check(`${point.name}：赶上了这个阶段`, exercised);");
  });

  it("日常写入 8 轮，在途的那一条按同一 op_id 重放", () => {
    expect(drill).toContain("const WRITE_ROUNDS = 8;");
    expect(drill).toContain("const random = lcg(0x5eed);");
  });

  it("坏库（07 S5′）：不服务、不隔离、不改库，恢复页可见；恢复靠控制台输入 ID，不用 --yes", () => {
    expect(drill).toContain('await untilLogged(broken, "DATABASE_DAMAGED", 60_000)');
    expect(drill).toMatch(
      /const untouched = \(\) =>\s*!existsSync\(join\(n, "quarantine"\)\) && existsSync\(db\) && readFileSync\(db\)\.equals\(damaged\);/u,
    );
    expect(drill).toMatch(/"坏库没有被隔离，也没有建新库，字节不变", untouched\(\)\)/u);
    expect(drill).toMatch(/refused\.code === 5 && untouched\(\)/u);
    expect(drill).toContain('page.getByText("数据库读不出，需要从备份恢复")');
    expect(drill).toContain('check("看过恢复页之后库仍然没动", untouched());');
    expect(drill).not.toContain('"--yes"');
    expect(drill.match(/`\$\{backupId\}\\n`/gu)?.length).toBeGreaterThanOrEqual(3);
  });

  it("报告记下跑了哪些场景，有一项不过就以非零退出", () => {
    expect(drill).toMatch(/for \(const name of POWER_LOSS_SCENARIOS\)/u);
    expect(drill).toContain("scenarios: ran,");
    expect(drill).toContain("passed: error === null && failed.length === 0 && checks.length > 0,");
    expect(drill).toContain("process.exitCode = report.passed ? 0 : 1;");
  });
});

describe("掉电演练接在发布链上", () => {
  it("release.ts 在打包与 smoke 之后跑全部场景", () => {
    const release = read("scripts", "release.ts");
    const stage = release.indexOf(
      '{ name: "power-loss", args: ["exec", "tsx", "scripts/power-loss-drill.ts"] }',
    );
    expect(stage).toBeGreaterThan(release.indexOf('name: "packaged-smoke"'));
    expect(stage).toBeGreaterThan(release.indexOf('name: "package"'));
  });

  it("assemble 要求这个阶段绿、报告放行，并且在写出发布目录之前", () => {
    const assemble = read("scripts", "assemble-release.ts");
    expect(assemble).toMatch(/"budget",\s*"power-loss",\s*\] as const;/u);
    const gate = assemble.indexOf("const powerLossProblems = powerLossReportProblems(powerLoss);");
    expect(gate).toBeGreaterThan(0);
    expect(assemble).toContain(
      "if (powerLossProblems.length > 0)\n  throw new Error(`POWER_LOSS_REPORT_INPUT_FAILED:",
    );
    expect(gate).toBeLessThan(assemble.indexOf("await rm(releaseDir"));
  });

  it("报告进 resume 证据与 CI 证据", () => {
    expect(read("scripts", "release-artifact-evidence.ts")).toContain(
      '"output/power-loss/report.json",',
    );
    expect(read(".github", "workflows", "windows-release-validation.yml")).toContain(
      "            output/power-loss/report.json\n",
    );
  });
});

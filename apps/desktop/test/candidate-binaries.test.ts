import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { APP_LAYOUT } from "../../../scripts/app-layout.js";
import {
  BINARY_KEYS,
  binariesOf,
  candidateBindingMismatches,
  candidateBinariesPath,
  readCandidateBinaries,
  staleBinaryKeys,
  writeCandidateBinaries,
  zipBinaries,
  type BinarySet,
  type BoundReports,
  type CandidateBinaries,
} from "../../../scripts/candidate-binaries.js";

// 09 §3 L6：绿灯必须来自这次要发的那份二进制。打包时记下五个 exe 的哈希，归档与每份验收报告
// 都要对上；这里的每一条都对应一种「拿别的构建的绿灯冒充候选」的穿法。
const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(process.cwd(), "output", "candidate-binaries-test-"));
  temporary.push(dir);
  return dir;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function appDir(root: string, name: string, tag: string): string {
  const dir = join(root, name);
  for (const key of BINARY_KEYS) {
    const path = join(dir, APP_LAYOUT[key]);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${tag}:${key}`);
  }
  return dir;
}

function set(tag: string): BinarySet {
  return Object.fromEntries(BINARY_KEYS.map((key) => [key, sha(`${tag}:${key}`)])) as BinarySet;
}

const candidate: CandidateBinaries = {
  schema: 1,
  version: "8.1.2",
  release: set("release"),
  smoke: { ...set("release"), host: sha("smoke:host") },
};

function boundReports(): BoundReports {
  return {
    packaged: { binaries: { ...candidate.smoke } },
    portable: { binaries: { ...candidate.release } },
    distribution: { binaries: { ...candidate.release } },
    installed: { binaries: { ...candidate.release } },
    // 演练的 setup 是 drill 构建：哈希本来就不同。
    drill: { binaries: { ...candidate.release, setup: sha("drill:setup") } },
    budget: { binaries: { production: { ...candidate.release }, smoke: { ...candidate.smoke } } },
    powerLoss: {
      binaries: { production: { ...candidate.release }, smoke: { ...candidate.smoke } },
    },
  };
}

describe("候选绑定（L6）", () => {
  it("打包时记下 release 与 smoke 两套哈希，读回来逐字节一样", () => {
    const root = scratch();
    mkdirSync(dirname(candidateBinariesPath(root)), { recursive: true });
    const written = writeCandidateBinaries(root, {
      version: "8.1.2",
      releaseAppDir: appDir(root, "release", "release"),
      smokeAppDir: appDir(root, "smoke", "smoke"),
    });
    expect(written).toEqual({
      schema: 1,
      version: "8.1.2",
      release: set("release"),
      smoke: set("smoke"),
    });
    expect(readCandidateBinaries(root)).toEqual(written);
    expect(binariesOf(join(root, "release"))).toEqual(set("release"));
  });

  it("少一个 exe 或记下的哈希不像哈希都拒绝，不拿半份清单放行", () => {
    const root = scratch();
    const dir = appDir(root, "release", "release");
    rmSync(join(dir, APP_LAYOUT.mcpShim));
    expect(() => binariesOf(dir)).toThrow(/CANDIDATE_BINARY_MISSING/u);

    mkdirSync(dirname(candidateBinariesPath(root)), { recursive: true });
    writeFileSync(
      candidateBinariesPath(root),
      JSON.stringify({ ...candidate, smoke: { ...candidate.smoke, cli: "not-a-hash" } }),
    );
    expect(() => readCandidateBinaries(root)).toThrow(/CANDIDATE_BINARIES_INVALID: cli/u);
    rmSync(candidateBinariesPath(root));
    expect(() => readCandidateBinaries(root)).toThrow(/CANDIDATE_BINARIES_MISSING/u);
  });

  it("从版本 zip 与便携 zip（带顶层目录）里取出的哈希就是 exe 本身的哈希", () => {
    const files = (prefix: string) =>
      Object.fromEntries(
        BINARY_KEYS.map((key) => [
          `${prefix}${APP_LAYOUT[key].replaceAll("\\", "/")}`,
          strToU8(`release:${key}`),
        ]),
      );
    expect(zipBinaries(zipSync({ ...files(""), "resources/other.txt": strToU8("x") }))).toEqual(
      set("release"),
    );
    expect(
      zipBinaries(zipSync(files("AyanamiTaskManager-8.1.2/")), "AyanamiTaskManager-8.1.2/"),
    ).toEqual(set("release"));
    // 前缀不对就是没找到，不会退回去拿别处同名的文件。
    expect(() => zipBinaries(zipSync(files("AyanamiTaskManager-8.1.2/")))).toThrow(
      /CANDIDATE_BINARY_MISSING/u,
    );
  });

  it("每份报告都对上才放行；演练只比 setup 以外的四个", () => {
    expect(candidateBindingMismatches(candidate, boundReports())).toEqual([]);
    // 安装验收在非干净机器上跳过：没有那份报告，不算对不上。
    expect(candidateBindingMismatches(candidate, { ...boundReports(), installed: null })).toEqual(
      [],
    );
  });

  it("任何一份报告测的是别的构建、或者没写哈希，都点名拒绝", () => {
    const cases: Array<[string, (reports: BoundReports) => void]> = [
      ["packaged-smoke.host", (r) => (r.packaged.binaries!.host = candidate.release.host)],
      ["portable-smoke.cli", (r) => (r.portable.binaries!.cli = sha("old:cli"))],
      ["distribution-smoke.launcher", (r) => delete r.distribution.binaries!.launcher],
      ["installed-smoke.setup", (r) => (r.installed!.binaries!.setup = sha("old:setup"))],
      ["install-drill.mcpShim", (r) => (r.drill.binaries!.mcpShim = sha("old:shim"))],
      [
        "budget.production.host",
        (r) => (r.budget.binaries!.production!.host = candidate.smoke.host),
      ],
      ["budget.smoke.host", (r) => (r.budget.binaries!.smoke!.host = candidate.release.host)],
      [
        "power-loss.production.host",
        (r) => (r.powerLoss.binaries!.production!.host = candidate.smoke.host),
      ],
      ["power-loss.smoke.cli", (r) => delete r.powerLoss.binaries!.smoke!.cli],
    ];
    for (const [expected, mutate] of cases) {
      const reports = boundReports();
      mutate(reports);
      expect(candidateBindingMismatches(candidate, reports), expected).toEqual([expected]);
    }
    const unbound = boundReports();
    unbound.distribution.binaries = null;
    expect(candidateBindingMismatches(candidate, unbound)).toEqual(
      BINARY_KEYS.map((key) => `distribution-smoke.${key}`),
    );
    const noBudget = boundReports();
    noBudget.budget = {};
    expect(candidateBindingMismatches(candidate, noBudget)).toHaveLength(BINARY_KEYS.length * 2);
    const noPowerLoss = boundReports();
    noPowerLoss.powerLoss = {};
    expect(candidateBindingMismatches(candidate, noPowerLoss)).toHaveLength(BINARY_KEYS.length * 2);
  });

  it("大写的十六进制也认（PowerShell Get-FileHash 写的是大写）", () => {
    const reports = boundReports();
    reports.portable.binaries = Object.fromEntries(
      Object.entries(candidate.release).map(([key, value]) => [key, value.toUpperCase()]),
    );
    expect(candidateBindingMismatches(candidate, reports)).toEqual([]);
  });
});

describe("assemble-release 用上了候选绑定", () => {
  const source = readFileSync(join(process.cwd(), "scripts", "assemble-release.ts"), "utf8");

  it("归档里的五个 exe 与每份报告都对候选，对不上就拒绝组装", () => {
    expect(source).toContain("const candidateBinaries = readCandidateBinaries(root);");
    expect(source).toContain("zipBinaries(readFileSync(join(packageDir, packageName)))");
    expect(source).toMatch(
      /zipBinaries\(\s*readFileSync\(join\(packageDir, portableName\)\),\s*`AyanamiTaskManager-\$\{packageJson\.version\}\/`,?\s*\)/u,
    );
    expect(source).toMatch(
      /candidateBindingMismatches\(candidateBinaries, \{\s*packaged: packagedSmoke,\s*portable: portableSmoke,\s*distribution: distributionSmoke,\s*installed: installedSmoke,\s*drill,\s*budget,\s*powerLoss,\s*\}\)/u,
    );
    expect(source).toContain(
      'if (unbound.length > 0) throw new Error(`CANDIDATE_BINARY_MISMATCH: ${unbound.join(", ")}`);',
    );
    // 绑定在写出任何发布文件之前。
    expect(source.indexOf("candidateBindingMismatches(")).toBeLessThan(
      source.indexOf('await writeFile(join(releaseDir, "sbom.spdx.json")'),
    );
  });

  it("候选哈希表随证据一起进发布目录", () => {
    expect(source).toContain('["package/candidate-binaries.json", "candidate-binaries.json"],');
    expect(source).toContain('["drill/report.json", "install-drill-report.json"],');
    expect(source).toContain('["budget-report.json", "budget-report.json"],');
    expect(source).toContain('["power-loss/report.json", "power-loss-report.json"],');
  });
});

// 绑定只有两头都在才成立：打包记下候选，每份报告写出自己实际运行的那份 exe。
describe("候选与报告两头都写了哈希", () => {
  const read = (file: string) => readFileSync(join(process.cwd(), "scripts", file), "utf8");

  it("打包阶段在生产包与 smoke 包都打好之后记下两套哈希", () => {
    const source = read("package-native.ts");
    const body = source.slice(source.indexOf("export function packageRelease("));
    expect(body).toMatch(
      /writeCandidateBinaries\(root, \{\s*version: release\.version,\s*releaseAppDir: release\.appDir,\s*smokeAppDir: smoke\.appDir,\s*\}\);\s*return \{ release, portable \};/u,
    );
  });

  it("每份验收报告写的是它实际运行的那份 exe", () => {
    expect(read("packaged-smoke.ts")).toContain("binaries: binariesOf(dirname(executable)),");
    const distribution = read("distribution-smoke.ts");
    expect(distribution).toContain("portableBinaries = binariesOf(appDir);");
    expect(distribution).toContain(
      'await writeSmokeReport("portable", dataDir, from, portableBinaries);',
    );
    expect(distribution.match(/binaries: portableBinaries,/gu)).toHaveLength(2);
    const installed = read("distribution-installed.ts");
    expect(installed).toContain(
      "const binaries = binariesOf(join(installRoot, `app-${packageVersion}`));",
    );
    expect(installed).toContain('await writeSmokeReport("installed", realN, from, binaries);');
    expect(read("budget-measure.ts")).toMatch(
      /report\.binaries = \{\s*production: binariesOf\(dirname\(production\)\),\s*smoke: binariesOf\(dirname\(smoke\)\),\s*\};/u,
    );
    expect(read("power-loss-drill.ts")).toMatch(
      /binaries: \{\s*production: binariesOf\(dirname\(executable\)\),\s*smoke: binariesOf\(dirname\(smokeExecutable\(\)\)\),\s*\},/u,
    );
    const drill = read("install-drill.ts");
    expect(drill).toContain("...(existsSync(app) ? binariesOf(app) : {}),");
    expect(drill).toContain("binaries: drillBinaries(),");
  });
});

// W8d-5 全链实测：install-drill 复用了上回留下的演练包，报告里的 exe 哈希与候选对不上——演练测的
// 是旧构建。包只有在里面的 exe 就是当前构建时才能复用；发布链干脆每次重打。
describe("演练包必须是当前构建打的", () => {
  it("版本目录里的 exe 与期望逐个比，对不上的点名，不完整的算缺", () => {
    const root = scratch();
    const dir = appDir(root, "app-9.0.0", "release");
    expect(staleBinaryKeys(dir, set("release"))).toEqual([]);
    expect(staleBinaryKeys(dir, { ...set("release"), cli: sha("new:cli") })).toEqual([
      "package.cli",
    ]);
    rmSync(join(dir, APP_LAYOUT.launcher));
    expect(staleBinaryKeys(dir, set("release"))).toEqual(["package.missing"]);
    expect(staleBinaryKeys(join(root, "absent"), set("release"))).toEqual(["package.missing"]);
  });

  it("install-drill 先构建 drill setup，再拿当前构建比包，对不上就重打", () => {
    const drill = readFileSync(join(process.cwd(), "scripts", "install-drill.ts"), "utf8");
    const body = drill.slice(
      drill.indexOf("function packages(rebuild: boolean)"),
      drill.indexOf("type Packages = "),
    );
    expect(body.indexOf("buildDrillSetup(root);")).toBeGreaterThan(0);
    expect(body.indexOf("buildDrillSetup(root);")).toBeLessThan(
      body.indexOf("const expected = currentDrillBinaries();"),
    );
    expect(body).toContain("staleBinaryKeys(join(out(version), `app-${version}`), expected)");
    expect(body).toMatch(/rebuild \|\|\s+stale\.length > 0 \|\|/u);
    // 期望的五个 exe：当前的生产宿主、启动器、CLI、shim，加这份源码的 drill setup。
    expect(drill).toMatch(
      /host: release\.host,\s+launcher: release\.launcher,\s+setup: drillSetup\(root\),\s+cli: release\.cli,\s+mcpShim: join\(root, MCP_SHIM_RELEASE_EXE\),/u,
    );
  });
});

describe("发布入口复核演练、预算与候选", () => {
  const publish = readFileSync(
    join(process.cwd(), ".github", "scripts", "publish-verified-release.mjs"),
    "utf8",
  );

  it("install-drill、budget、power-loss 三个阶段都得绿，报告逐份复核", () => {
    expect(publish).toMatch(/"install-drill",\s*"budget",\s*"power-loss",\s*\];/u);
    expect(publish).not.toContain("benchmark-report.json");
    expect(publish).toContain(
      'readJson(join(releaseRoot, "test-report/install-drill-report.json"))',
    );
    expect(publish).toContain("assert.equal(drill.failed, 0);");
    expect(publish).toContain('assert.equal(typeof budget.completedAt, "string");');
    expect(publish).toContain('readJson(join(releaseRoot, "test-report/power-loss-report.json"))');
    expect(publish).toContain("assert.equal(powerLoss.failed, 0);");
    expect(publish).toContain(
      'assert.deepEqual(powerLoss.scenarios, ["conversion", "writes", "recover"]);',
    );
    expect(publish).toMatch(
      /\(await readJson\(join\(releaseRoot, "test-report\/candidate-binaries\.json"\)\)\)\.version,\s*version,/u,
    );
  });
});

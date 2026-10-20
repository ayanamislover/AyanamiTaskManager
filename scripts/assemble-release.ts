import { existsSync, readdirSync, readFileSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  createReleaseResumeEvidence,
  identifyReleaseArtifact,
  releaseResumeEvidencePaths,
} from "./release-artifact-evidence.js";
import {
  appendReleaseEvidenceLayer,
  assertReleaseChecklistIsDynamic,
  assertReleaseEvidenceResolves,
  createReleaseCandidateIdentity,
  highestReleaseEvidenceLevel,
  nonBlockingItems,
  RELEASE_REPORT_LOG_DIR,
  releaseLogReportPath,
  stageProvenance,
  type ReleaseArtifactIdentity,
  type ReleaseEvidenceLayer,
  type ReleaseEvidenceReference,
  type StageDecisions,
} from "./release-report.js";
import { verifyReleaseSource, type ReleaseFingerprint } from "./release-fingerprint.js";
import { MIN_WEBVIEW2, portableZipName } from "./package-native.js";
import { buildSbom, releaseNoticesStatus, shippedComponents } from "./third-party-notices.js";
import {
  candidateBindingMismatches,
  readCandidateBinaries,
  zipBinaries,
  type BinarySet,
  type BoundReports,
} from "./candidate-binaries.js";
import { budgetReportProblems } from "./budget-verdicts.js";
import { powerLossReportProblems, type PowerLossReport } from "./power-loss-report.js";
import { isV3 } from "./version-sites.js";

type Artifact = ReleaseArtifactIdentity;
type Verification = {
  passed: boolean;
  completedAt: string;
  fingerprint: ReleaseFingerprint;
  stages?: StageDecisions;
  commands: Array<{
    name: string;
    command: string;
    exitCode: number;
    durationMs: number;
    log: string;
  }>;
};

type SmokeReport = {
  passed: boolean;
  completedAt: string;
  checks: Array<{ passed: boolean }>;
  /** 这份报告测的那份 exe 的哈希（候选绑定 L6）。 */
  binaries?: Partial<BinarySet>;
};

/** distribution-smoke 记下安装验收是做了还是因为不是声明过的干净机器而跳过。 */
type DistributionReport = Omit<SmokeReport, "binaries"> & {
  installed: "verified" | "skipped";
  binaries?: Partial<BinarySet> | null;
};

const assembleArguments = process.argv.slice(2);
const unknownArguments = assembleArguments.filter((argument) => argument !== "--local-only");
if (unknownArguments.length > 0)
  throw new Error(`RELEASE_ARGUMENT_UNKNOWN: ${unknownArguments.join(", ")}`);
/** 本机安装验收：允许组装不可分发的候选（release.json 照实记 distributable）。 */
const localOnly = assembleArguments.includes("--local-only");
const root = resolve(process.cwd());
const releaseDir = resolve(root, "release");
if (!releaseDir.toLowerCase().startsWith(`${root.toLowerCase()}${sep}`)) {
  throw new Error(`RELEASE_OUTSIDE_WORKSPACE: ${releaseDir}`);
}
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
  name: string;
  productName: string;
  version: string;
  license: string;
};

async function digest(path: string): Promise<string> {
  return (await identifyReleaseArtifact(path)).sha256;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function assertSmokeReport(name: string, report: Pick<SmokeReport, "passed" | "checks">): void {
  if (
    report.passed !== true ||
    report.checks.length === 0 ||
    report.checks.some((check) => check.passed !== true)
  ) {
    throw new Error(`SMOKE_REPORT_INPUT_FAILED: ${name}`);
  }
}

async function evidence(path: string, reportPath: string): Promise<ReleaseEvidenceReference> {
  return { path: reportPath, sha256: await digest(path) };
}

function latestSchema(directory: string): number {
  return Math.max(
    ...readdirSync(directory)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => Number.parseInt(name, 10))
      .filter(Number.isFinite),
  );
}

/**
 * 3.0 的包里没有 Node（W8a）：SQLite 是 rusqlite 静态链接进各个 exe 的那一份，版本以 `--locked`
 * 构建所用的 Cargo.lock 为准（libsqlite3-sys 的 bundled 版本）。
 */
function bundledSqliteCrate(): string {
  const lock = readFileSync(join(root, "apps", "desktop", "native", "Cargo.lock"), "utf8");
  const match = /\[\[package\]\]\r?\nname = "libsqlite3-sys"\r?\nversion = "([^"]+)"/u.exec(lock);
  if (!match) throw new Error("RELEASE_SQLITE_CRATE_MISSING: Cargo.lock 里没有 libsqlite3-sys");
  return `libsqlite3-sys ${match[1]}`;
}

// 3.x 的升级、转换与保活都按主版本认 3.x（install-state `is_v3`）：2.x 号的候选装上去会被当成 2.x。
if (!isV3(packageJson.version)) throw new Error(`RELEASE_VERSION_NOT_V3: ${packageJson.version}`);

const output = join(root, "output");
const verification = await readJson<Verification>(join(output, "release-verification.json"));
if (!verification.passed) throw new Error("RELEASE_VERIFICATION_FAILED");
const requiredCommands = [
  "lint",
  "format",
  "typecheck",
  "test",
  "e2e",
  "build",
  "package",
  "packaged-smoke",
  "distribution-smoke",
  "install-drill",
  "budget",
  "power-loss",
] as const;
const commandNames = verification.commands.map((command) => command.name);
if (
  new Set(commandNames).size !== commandNames.length ||
  requiredCommands.some(
    (name) => verification.commands.find((command) => command.name === name)?.exitCode !== 0,
  )
) {
  throw new Error("RELEASE_VERIFICATION_COMMANDS_INVALID");
}
const source = await verifyReleaseSource(root, verification.fingerprint);
const e2e = await readJson<{ stats: Record<string, number> }>(join(output, "e2e", "results.json"));
// 2.x 的 benchmark（测的是 Node 服务）不在 3.0 的链上：原生的内存、冷启动与 Agent 负载由 budget 量。
type DrillReport = BoundReports["drill"] & { passed: boolean; total: number; failed: number };
type BudgetReport = BoundReports["budget"] & {
  completedAt?: string;
  error?: string;
  /** 08 §3 逐条判定（budget-verdicts.ts）：全部达标才组装；预算不放宽，除非用户同意。 */
  summary?: { allPass?: boolean; verdicts?: Array<{ item: string; pass: boolean }> };
};
const drill = await readJson<DrillReport>(join(output, "drill", "report.json"));
const budget = await readJson<BudgetReport>(join(output, "budget-report.json"));
if (drill.passed !== true || !(drill.total > 0) || drill.failed !== 0)
  throw new Error("DRILL_REPORT_INPUT_FAILED");
// 不只看 allPass：十条一条不少、每条达标、样本数够（budget-verdicts.ts，W8 关口 peer r1 P2-02）。
const budgetProblems = budgetReportProblems(budget);
if (budgetProblems.length > 0)
  throw new Error(`BUDGET_REPORT_INPUT_FAILED: ${budgetProblems.join(" | ")}`);
// 掉电演练（W8f）：三个场景都跑过、每项通过（power-loss-report.ts）；二进制下面与候选一起对。
const powerLoss = await readJson<BoundReports["powerLoss"] & PowerLossReport>(
  join(output, "power-loss", "report.json"),
);
const powerLossProblems = powerLossReportProblems(powerLoss);
if (powerLossProblems.length > 0)
  throw new Error(`POWER_LOSS_REPORT_INPUT_FAILED: ${powerLossProblems.join(" | ")}`);
const packagedSmoke = await readJson<SmokeReport>(join(output, "packaged-smoke-report.json"));
const portableSmoke = await readJson<SmokeReport>(join(output, "portable-smoke-report.json"));
const distributionSmoke = await readJson<DistributionReport>(
  join(output, "distribution-smoke-report.json"),
);
if (distributionSmoke.installed !== "verified" && distributionSmoke.installed !== "skipped") {
  throw new Error("DISTRIBUTION_INSTALLED_STATE_INVALID");
}
// 安装验收只在干净机器上做；显式跳过时没有 installed 报告，INSTALLED 层随之缺席。
const installedSmoke =
  distributionSmoke.installed === "verified"
    ? await readJson<SmokeReport>(join(output, "installed-smoke-report.json"))
    : null;
if (
  !packagedSmoke.passed ||
  !portableSmoke.passed ||
  (installedSmoke !== null && !installedSmoke.passed) ||
  !distributionSmoke.passed ||
  Number(e2e.stats.unexpected) > 0
) {
  throw new Error("TEST_REPORT_INPUT_FAILED");
}
assertSmokeReport("packaged", packagedSmoke);
assertSmokeReport("portable", portableSmoke);
if (installedSmoke) assertSmokeReport("installed", installedSmoke);
assertSmokeReport("distribution", distributionSmoke);

// 打包阶段（package-native --release）的产物：安装器、版本包、清单放同一目录就是安装包；
// 便携 zip 是同一个版本目录加 portable 标记。
const packageDir = join(output, "package");
const setupName = "atm-setup.exe";
const packageName = `atm-${packageJson.version}-win-x64.zip`;
const manifestName = `atm-${packageJson.version}-win-x64.json`;
const portableName = portableZipName(packageJson.version);
const releaseNames = [setupName, packageName, manifestName, portableName];
const missing = releaseNames.filter((name) => !existsSync(join(packageDir, name)));
if (missing.length > 0) throw new Error(`打包产物不完整：缺少 ${missing.join("、")}`);
// 声明从将要发出去的归档里取，不看旁边的松散目录。有组件缺许可文本（LICENSE_TEXT_PENDING）
// 的候选不可分发：只有本机安装验收（--local-only，release-and-install 传）能继续组装，
// release.json 记 distributable:false，发布入口见到就拒绝。
// 候选绑定（09 §3，L6）：打包阶段记下的五个 exe 就是归档里发出去的那份，每份验收报告测的也是它。
const candidateBinaries = readCandidateBinaries(root);
if (candidateBinaries.version !== packageJson.version)
  throw new Error(`CANDIDATE_BINARY_MISMATCH: version ${candidateBinaries.version}`);
const archived = [
  ["package", zipBinaries(readFileSync(join(packageDir, packageName)))],
  [
    "portable",
    zipBinaries(
      readFileSync(join(packageDir, portableName)),
      `AyanamiTaskManager-${packageJson.version}/`,
    ),
  ],
] as const;
for (const [label, set] of archived)
  for (const [key, sha] of Object.entries(set))
    if (candidateBinaries.release[key as keyof typeof set] !== sha)
      throw new Error(`CANDIDATE_BINARY_MISMATCH: ${label}.${key}`);
const unbound = candidateBindingMismatches(candidateBinaries, {
  packaged: packagedSmoke,
  portable: portableSmoke,
  distribution: distributionSmoke,
  installed: installedSmoke,
  drill,
  budget,
  powerLoss,
});
if (unbound.length > 0) throw new Error(`CANDIDATE_BINARY_MISMATCH: ${unbound.join(", ")}`);

const notices = releaseNoticesStatus({
  packageZip: readFileSync(join(packageDir, packageName)),
  portableZip: readFileSync(join(packageDir, portableName)),
  portableFolder: `AyanamiTaskManager-${packageJson.version}`,
  manifestFiles: (
    JSON.parse(readFileSync(join(packageDir, manifestName), "utf8")) as {
      files: Array<{ path: string; sha256: string }>;
    }
  ).files,
});
if (!notices.distributable && !localOnly)
  throw new Error(
    "RELEASE_NOTICES_INCOMPLETE: 归档里的第三方声明有组件缺许可文本（LICENSE_TEXT_PENDING）；" +
      "只做本机安装验收时用 --local-only",
  );

await rm(releaseDir, { recursive: true, force: true });
await mkdir(releaseDir, { recursive: true });
const testReportDir = join(releaseDir, "test-report");
await mkdir(testReportDir, { recursive: true });
for (const name of releaseNames) await copyFile(join(packageDir, name), join(releaseDir, name));

const artifacts: Artifact[] = [];
for (const name of releaseNames) {
  artifacts.push(await identifyReleaseArtifact(join(releaseDir, name), name));
}
const [setupArtifact, packageArtifact, manifestArtifact, portableArtifact] = artifacts;
if (!setupArtifact || !packageArtifact || !manifestArtifact || !portableArtifact) {
  throw new Error("RELEASE_ARTIFACT_IDENTITY_MISSING");
}
const candidate = createReleaseCandidateIdentity({
  version: packageJson.version,
  fingerprint: verification.fingerprint,
  artifacts: {
    setup: setupArtifact,
    portable: portableArtifact,
    package: packageArtifact,
    manifest: manifestArtifact,
  },
});
const githubActionsRun = process.env.GITHUB_ACTIONS === "true";
if (githubActionsRun && process.env.GITHUB_SHA?.toLowerCase() !== candidate.gitHead.toLowerCase()) {
  throw new Error("GITHUB_CANDIDATE_SHA_MISMATCH");
}

const reportInputs = [
  ["e2e/results.json", "e2e-results.json"],
  ["budget-report.json", "budget-report.json"],
  ["drill/report.json", "install-drill-report.json"],
  ["power-loss/report.json", "power-loss-report.json"],
  ["package/candidate-binaries.json", "candidate-binaries.json"],
  ["packaged-smoke-report.json", "packaged-smoke-report.json"],
  ["portable-smoke-report.json", "portable-smoke-report.json"],
  ...(installedSmoke
    ? [["installed-smoke-report.json", "installed-smoke-report.json"] as const]
    : []),
  ["distribution-smoke-report.json", "distribution-smoke-report.json"],
  ["release-verification.json", "release-verification.json"],
] as const;
for (const [source, target] of reportInputs) {
  await copyFile(join(output, source), join(testReportDir, target));
}
await cp(join(output, "release-logs"), join(releaseDir, ...RELEASE_REPORT_LOG_DIR.split("/")), {
  recursive: true,
});
const screenshots = [1366, 1920, 3440].map((width) => `e2e-project-${width}.png`);
await mkdir(join(testReportDir, "screenshots"), { recursive: true });
for (const screenshot of screenshots) {
  await copyFile(
    join(output, "playwright", screenshot),
    join(testReportDir, "screenshots", screenshot),
  );
}

const testLog = await readFile(join(output, "release-logs", "test.log"), "utf8");
const vitestCount = Number(/Tests\s+(\d+) passed/u.exec(testLog)?.[1] ?? 0);
if (!Number.isSafeInteger(vitestCount) || vitestCount <= 0 || Number(e2e.stats.expected) <= 0) {
  throw new Error("TEST_REPORT_COUNT_INVALID");
}
const provenance = (stage: string) => stageProvenance(verification.stages, stage);
const reused = (stage: string) => verification.stages?.[stage]?.reuse === true;
const releaseChecklist = await readFile(join(root, "docs", "release-checklist.md"), "utf8");
assertReleaseChecklistIsDynamic(releaseChecklist);
const remaining = nonBlockingItems(releaseChecklist);
const reportEvidence = async (name: string): Promise<ReleaseEvidenceReference> =>
  await evidence(join(testReportDir, name), `test-report/${name}`);
const artifactEvidence = (artifact: Artifact): ReleaseEvidenceReference => ({
  path: artifact.name,
  sha256: artifact.sha256,
});
let evidenceLayers: ReleaseEvidenceLayer[] = [];
evidenceLayers = appendReleaseEvidenceLayer(evidenceLayers, candidate, {
  level: "SOURCE_DONE",
  verifiedAt: verification.completedAt,
  origin: "source-checkout",
  evidence: [await reportEvidence("release-verification.json")],
});
const ciEvidence = await Promise.all([
  reportEvidence("release-verification.json"),
  // 摘要取发行目录里那份副本：报告里写的路径和被哈希的字节必须是同一个文件。
  ...verification.commands.map(async (command): Promise<ReleaseEvidenceReference> => {
    const reportPath = releaseLogReportPath(command.log);
    return await evidence(join(releaseDir, ...reportPath.split("/")), reportPath);
  }),
]);
evidenceLayers = appendReleaseEvidenceLayer(evidenceLayers, candidate, {
  level: "CI_VERIFIED",
  verifiedAt: verification.completedAt,
  origin: githubActionsRun ? "github-actions" : "local-ci-equivalent",
  evidence: ciEvidence,
});
evidenceLayers = appendReleaseEvidenceLayer(evidenceLayers, candidate, {
  level: "PACKAGED_VERIFIED",
  verifiedAt: packagedSmoke.completedAt,
  origin: "packaged-smoke",
  evidence: [
    await reportEvidence("packaged-smoke-report.json"),
    await reportEvidence("portable-smoke-report.json"),
    ...artifacts.map(artifactEvidence),
  ],
});
if (installedSmoke) {
  evidenceLayers = appendReleaseEvidenceLayer(evidenceLayers, candidate, {
    level: "INSTALLED_VERIFIED",
    verifiedAt: distributionSmoke.completedAt,
    origin: "installed-smoke",
    evidence: [
      await reportEvidence("installed-smoke-report.json"),
      await reportEvidence("distribution-smoke-report.json"),
      artifactEvidence(setupArtifact),
      artifactEvidence(packageArtifact),
      artifactEvidence(manifestArtifact),
    ],
  });
}
await assertReleaseEvidenceResolves(releaseDir, evidenceLayers, digest);
const highestVerifiedLevel = highestReleaseEvidenceLevel(evidenceLayers);
const summary = {
  schemaVersion: 2,
  candidate,
  highestVerifiedLevel,
  evidenceLayers,
  completedAt: verification.completedAt,
  results: {
    unitAndIntegration: {
      exitCode: verification.commands.find((entry) => entry.name === "test")?.exitCode,
      passed: vitestCount,
    },
    e2e: {
      exitCode: verification.commands.find((entry) => entry.name === "e2e")?.exitCode,
      passed: e2e.stats.expected,
      failed: e2e.stats.unexpected,
      flaky: e2e.stats.flaky,
      reused: reused("e2e"),
    },
    packagedSmoke: { checks: packagedSmoke.checks.length },
    portableSmoke: { checks: portableSmoke.checks.length },
    installedSmoke: installedSmoke ? { checks: installedSmoke.checks.length } : { skipped: true },
    distributionSmoke: {
      checks: distributionSmoke.checks.length,
      reused: reused("distribution-smoke"),
    },
    installDrill: { checks: drill.total },
    budget: { completedAt: budget.completedAt },
    powerLoss: { checks: powerLoss.total },
  },
  screenshots: screenshots.map((name) => `screenshots/${name}`),
  stages: verification.stages ?? {},
  commands: verification.commands,
  knownNonBlockingItems: remaining,
};
await writeFile(
  join(testReportDir, "summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
  "utf8",
);
await writeFile(
  join(testReportDir, "summary.md"),
  `# AyanamiTaskManager ${packageJson.version} 测试报告\n\n` +
    `- 候选：${candidate.candidateSha256}\n` +
    `- 最高证据层：${String(highestVerifiedLevel)}\n` +
    `- CI 证据来源：${evidenceLayers[1]?.origin ?? "缺失"}\n\n` +
    `## 证据层\n\n` +
    `| 层级 | 时间 | 证据数 |\n| --- | --- | ---: |\n` +
    evidenceLayers
      .map((layer) => `| ${layer.level} | ${layer.verifiedAt} | ${layer.evidence.length} |`)
      .join("\n") +
    `\n\n## 动态结果\n\n` +
    `- 单元/集成：${vitestCount} 项通过，退出码 0\n` +
    `- 桌面 E2E：${e2e.stats.expected} 项通过，失败 ${e2e.stats.unexpected}${provenance("e2e")}\n` +
    `- packaged smoke：${packagedSmoke.checks.length} 项通过\n` +
    `- portable smoke：${portableSmoke.checks.length} 项通过\n` +
    `- installed smoke：${installedSmoke ? `${installedSmoke.checks.length} 项通过` : "跳过（机器上已有安装）"}\n` +
    `- distribution smoke：${distributionSmoke.checks.length} 项通过${provenance("distribution-smoke")}\n` +
    `- install-drill：${drill.total} 项通过\n` +
    `- budget：已量（${String(budget.completedAt)}）\n` +
    `- power-loss：${String(powerLoss.total)} 项通过\n` +
    `- 已知非阻塞剩余项：${remaining.length === 0 ? "无" : `${remaining.length} 条\n${remaining.map((item) => `  - ${item}`).join("\n")}`}\n\n` +
    `原始 JSON、命令日志和 1366/1920/3440 截图均位于本目录。\n`,
  "utf8",
);

const release = {
  product: packageJson.productName,
  version: packageJson.version,
  distributable: notices.distributable,
  platform: "win32-x64",
  runtime: "native",
  webview2Min: MIN_WEBVIEW2,
  sqlite: bundledSqliteCrate(),
  schema: {
    v3: latestSchema(join(root, "apps", "desktop", "native", "store", "migrations")),
    // 2.x 数据根里转换器认得的最新迁移（转换时只读打开 L）。
    legacyRegistry: latestSchema(join(root, "migrations", "registry")),
    legacyProject: latestSchema(join(root, "migrations", "project")),
  },
  commit: source.gitHead,
  source,
  builtAt: new Date().toISOString(),
  candidate,
  artifacts,
  testReport: {
    path: "test-report/summary.json",
    highestVerifiedLevel,
    candidateSha256: candidate.candidateSha256,
  },
};
await writeFile(join(releaseDir, "release.json"), `${JSON.stringify(release, null, 2)}\n`, "utf8");

const namespace = `https://ayanami.local/spdx/${packageJson.name}/${packageJson.version}/${artifacts[0]!.sha256.slice(0, 16).toLowerCase()}`;
const sbom = buildSbom({
  product: packageJson.productName,
  version: packageJson.version,
  license: packageJson.license,
  namespace,
  created: new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
  components: shippedComponents(root),
});
await writeFile(join(releaseDir, "sbom.spdx.json"), `${JSON.stringify(sbom, null, 2)}\n`, "utf8");

const checksumNames = [...releaseNames, "release.json", "sbom.spdx.json"];
const checksums = await Promise.all(
  checksumNames.map(async (name) => `${await digest(join(releaseDir, name))}  ${name}`),
);
await writeFile(join(releaseDir, "SHA256SUMS.txt"), `${checksums.join("\n")}\n`, "utf8");

const resumeEvidence = await createReleaseResumeEvidence(
  root,
  candidate,
  releaseResumeEvidencePaths(candidate, verification.commands, {
    installed: installedSmoke !== null,
  }),
);
await writeFile(
  join(output, "release-resume-evidence.json"),
  `${JSON.stringify(resumeEvidence, null, 2)}\n`,
  "utf8",
);

process.stdout.write(
  `${JSON.stringify({ releaseDir: relative(root, releaseDir), artifacts: checksumNames, testReport: "test-report/summary.json" }, null, 2)}\n`,
);

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import Database from "better-sqlite3";
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
import { APP_LAYOUT } from "./app-layout.js";
import { MIN_WEBVIEW2, portableZipName } from "./package-native.js";
import { releaseNoticesStatus } from "./third-party-notices.js";

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
};

/** distribution-smoke 记下安装验收是做了还是因为机器上已有安装而显式跳过。 */
type DistributionReport = SmokeReport & { installed: "verified" | "skipped" };

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
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

async function digest(path: string): Promise<string> {
  return (await identifyReleaseArtifact(path)).sha256;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function assertSmokeReport(name: string, report: SmokeReport): void {
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
 * 发布清单描述的是实际交付的运行时：直接问包里那个改了名的 node（runtime\atm-core.exe），
 * 它也是已经通过烟测的那一份。开发机上的 node 不是交付物。
 */
function runtimeVersions(): Record<string, string> {
  const executable = join(
    root,
    "output",
    "package",
    `app-${packageJson.version}`,
    APP_LAYOUT.coreExe,
  );
  const probe = spawnSync(executable, ["-p", "JSON.stringify(process.versions)"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (probe.error) throw new Error(`无法启动发行包里的运行时：${probe.error.message}`);
  if (probe.status !== 0) {
    throw new Error(`无法读取运行时版本：${String(probe.stderr ?? "").slice(0, 500)}`);
  }
  return JSON.parse(probe.stdout.trim()) as Record<string, string>;
}

function spdxId(name: string): string {
  return `SPDXRef-Package-${name.replace(/[^A-Za-z0-9.-]+/gu, "-")}`;
}

const output = join(root, "output");
const verification = await readJson<Verification>(join(output, "release-verification.json"));
if (!verification.passed) throw new Error("RELEASE_VERIFICATION_FAILED");
const requiredCommands = [
  "lint",
  "format",
  "typecheck",
  "test",
  "e2e",
  "benchmark",
  "build",
  "package",
  "packaged-smoke",
  "distribution-smoke",
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
const benchmark = await readJson<{ passed: boolean; metrics: Record<string, unknown> }>(
  join(output, "benchmark-report.json"),
);
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
  !benchmark.passed ||
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
// 声明从将要发出去的归档里取，不看旁边的松散目录。缺 Node 许可证原文（NODE_LICENSE_PENDING）
// 的候选不可分发：只有本机安装验收（--local-only，release-and-install 传）能继续组装，
// release.json 记 distributable:false，发布入口见到就拒绝。
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
    "RELEASE_NOTICES_INCOMPLETE: 归档里的第三方声明没有随包 Node 的许可证（third_party/node/）；" +
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
  ["benchmark-report.json", "benchmark-report.json"],
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
    benchmark: { metrics: benchmark.metrics, reused: reused("benchmark") },
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
    `- benchmark：全部阈值通过${provenance("benchmark")}\n` +
    `- 已知非阻塞剩余项：${remaining.length === 0 ? "无" : `${remaining.length} 条\n${remaining.map((item) => `  - ${item}`).join("\n")}`}\n\n` +
    `原始 JSON、命令日志和 1366/1920/3440 截图均位于本目录。\n`,
  "utf8",
);

const versions = runtimeVersions();
const sqlite = new Database(":memory:");
const sqliteVersion = String(
  (sqlite.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version,
);
sqlite.close();
const release = {
  product: packageJson.productName,
  version: packageJson.version,
  distributable: notices.distributable,
  platform: "win32-x64",
  node: versions.node,
  nodeAbi: versions.modules,
  napi: versions.napi,
  webview2Min: MIN_WEBVIEW2,
  sqlite: sqliteVersion,
  schema: {
    registry: latestSchema(join(root, "migrations", "registry")),
    project: latestSchema(join(root, "migrations", "project")),
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

const dependencies = Object.entries({
  ...packageJson.dependencies,
  ...packageJson.devDependencies,
}).sort(([a], [b]) => a.localeCompare(b));
const namespace = `https://ayanami.local/spdx/${packageJson.name}/${packageJson.version}/${artifacts[0]!.sha256.slice(0, 16).toLowerCase()}`;
const sbom = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: `${packageJson.productName}-${packageJson.version}`,
  documentNamespace: namespace,
  creationInfo: {
    created: new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
    creators: ["Tool: AyanamiTaskManager release assembler"],
  },
  documentDescribes: ["SPDXRef-Package-AyanamiTaskManager"],
  packages: [
    {
      name: packageJson.productName,
      SPDXID: "SPDXRef-Package-AyanamiTaskManager",
      versionInfo: packageJson.version,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: packageJson.license,
      licenseDeclared: packageJson.license,
      copyrightText: "NOASSERTION",
    },
    ...dependencies.map(([name, version]) => ({
      name,
      SPDXID: spdxId(name),
      versionInfo: version,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: "NOASSERTION",
      licenseDeclared: "NOASSERTION",
      copyrightText: "NOASSERTION",
    })),
  ],
  relationships: dependencies.map(([name]) => ({
    spdxElementId: "SPDXRef-Package-AyanamiTaskManager",
    relationshipType: "DEPENDS_ON",
    relatedSpdxElement: spdxId(name),
  })),
};
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

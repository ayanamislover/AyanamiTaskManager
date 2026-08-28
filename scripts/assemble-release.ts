import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import {
  createReleaseResumeEvidence,
  identifyReleaseArtifact,
  releaseResumeEvidencePaths,
} from "./release-artifact-evidence.js";
import {
  appendReleaseEvidenceLayer,
  assertReleaseChecklistIsDynamic,
  createReleaseCandidateIdentity,
  highestReleaseEvidenceLevel,
  nonBlockingItems,
  stageProvenance,
  type ReleaseArtifactIdentity,
  type ReleaseEvidenceLayer,
  type ReleaseEvidenceReference,
  type StageDecisions,
} from "./release-report.js";
import { verifyReleaseSource, type ReleaseFingerprint } from "./release-fingerprint.js";

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

async function filesBelow(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await filesBelow(path)));
    else result.push(path);
  }
  return result;
}

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

function electronVersions(): Record<string, string> {
  const executable = join(root, "node_modules", "electron", "dist", "electron.exe");
  const probe = spawnSync(executable, ["-p", "JSON.stringify(process.versions)"], {
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  if (probe.status !== 0) throw new Error(`无法读取 Electron ABI：${probe.stderr}`);
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
  "forge-make",
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
const installedSmoke = await readJson<SmokeReport>(join(output, "installed-smoke-report.json"));
const distributionSmoke = await readJson<SmokeReport>(
  join(output, "distribution-smoke-report.json"),
);
if (
  !benchmark.passed ||
  !packagedSmoke.passed ||
  !portableSmoke.passed ||
  !installedSmoke.passed ||
  !distributionSmoke.passed ||
  Number(e2e.stats.unexpected) > 0
) {
  throw new Error("TEST_REPORT_INPUT_FAILED");
}
assertSmokeReport("packaged", packagedSmoke);
assertSmokeReport("portable", portableSmoke);
assertSmokeReport("installed", installedSmoke);
assertSmokeReport("distribution", distributionSmoke);

const makeFiles = await filesBelow(join(root, "out", "make"));
const expectedSetupName =
  `AyanamiTaskManager-Setup-${packageJson.version}-win-x64.exe`.toLowerCase();
const expectedZipName = `AyanamiTaskManager-win32-x64-${packageJson.version}.zip`.toLowerCase();
const nupkgName = `AyanamiTaskManagerDesktop-${packageJson.version}-full.nupkg`;
const releasesName = "RELEASES";
const setupSource = makeFiles.find((path) => basename(path).toLowerCase() === expectedSetupName);
const zipSource = makeFiles.find((path) => basename(path).toLowerCase() === expectedZipName);
const squirrelDirectory = join(root, "out", "make", "squirrel.windows", "x64");
const nupkgSource = join(squirrelDirectory, nupkgName);
const releasesSource = join(squirrelDirectory, releasesName);
if (
  !setupSource ||
  !zipSource ||
  !makeFiles.includes(nupkgSource) ||
  !makeFiles.includes(releasesSource)
) {
  throw new Error("Forge make 产物不完整：缺少安装包、portable、NUPKG 或 RELEASES");
}

await rm(releaseDir, { recursive: true, force: true });
await mkdir(releaseDir, { recursive: true });
const testReportDir = join(releaseDir, "test-report");
await mkdir(testReportDir, { recursive: true });

const setupName = `AyanamiTaskManager-Setup-${packageJson.version}-win-x64.exe`;
const portableName = `AyanamiTaskManager-${packageJson.version}-win-x64-portable.zip`;
await copyFile(setupSource, join(releaseDir, setupName));
await copyFile(zipSource, join(releaseDir, portableName));
await copyFile(nupkgSource, join(releaseDir, nupkgName));
await copyFile(releasesSource, join(releaseDir, releasesName));

const artifacts: Artifact[] = [];
for (const name of [setupName, portableName, nupkgName, releasesName]) {
  const path = join(releaseDir, name);
  artifacts.push(await identifyReleaseArtifact(path, name));
}
const setupArtifact = artifacts.find((artifact) => artifact.name === setupName);
const portableArtifact = artifacts.find((artifact) => artifact.name === portableName);
const upgradePackageArtifact = artifacts.find((artifact) => artifact.name === nupkgName);
const releasesArtifact = artifacts.find((artifact) => artifact.name === releasesName);
if (!setupArtifact || !portableArtifact || !upgradePackageArtifact || !releasesArtifact) {
  throw new Error("RELEASE_ARTIFACT_IDENTITY_MISSING");
}
const candidate = createReleaseCandidateIdentity({
  version: packageJson.version,
  fingerprint: verification.fingerprint,
  artifacts: {
    setup: setupArtifact,
    portable: portableArtifact,
    upgradePackage: upgradePackageArtifact,
    releases: releasesArtifact,
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
  ["installed-smoke-report.json", "installed-smoke-report.json"],
  ["distribution-smoke-report.json", "distribution-smoke-report.json"],
  ["release-verification.json", "release-verification.json"],
] as const;
for (const [source, target] of reportInputs) {
  await copyFile(join(output, source), join(testReportDir, target));
}
await cp(join(output, "release-logs"), join(testReportDir, "logs"), { recursive: true });
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
  ...verification.commands.map(
    async (command): Promise<ReleaseEvidenceReference> =>
      await evidence(join(output, command.log), `test-report/${command.log}`),
  ),
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
evidenceLayers = appendReleaseEvidenceLayer(evidenceLayers, candidate, {
  level: "INSTALLED_VERIFIED",
  verifiedAt: distributionSmoke.completedAt,
  origin: "installed-smoke",
  evidence: [
    await reportEvidence("installed-smoke-report.json"),
    await reportEvidence("distribution-smoke-report.json"),
    artifactEvidence(setupArtifact),
    artifactEvidence(upgradePackageArtifact),
    artifactEvidence(releasesArtifact),
  ],
});
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
    installedSmoke: { checks: installedSmoke.checks.length },
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
    `- installed smoke：${installedSmoke.checks.length} 项通过\n` +
    `- distribution smoke：${distributionSmoke.checks.length} 项通过${provenance("distribution-smoke")}\n` +
    `- benchmark：全部阈值通过${provenance("benchmark")}\n` +
    `- 已知非阻塞剩余项：${remaining.length === 0 ? "无" : `${remaining.length} 条\n${remaining.map((item) => `  - ${item}`).join("\n")}`}\n\n` +
    `原始 JSON、命令日志和 1366/1920/3440 截图均位于本目录。\n`,
  "utf8",
);

const versions = electronVersions();
const sqlite = new Database(":memory:");
const sqliteVersion = String(
  (sqlite.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version,
);
sqlite.close();
const release = {
  product: packageJson.productName,
  version: packageJson.version,
  platform: "win32-x64",
  electron: versions.electron,
  node: versions.node,
  nodeAbi: versions.modules,
  napi: versions.napi,
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

const checksumNames = [
  setupName,
  portableName,
  nupkgName,
  releasesName,
  "release.json",
  "sbom.spdx.json",
];
const checksums = await Promise.all(
  checksumNames.map(async (name) => `${await digest(join(releaseDir, name))}  ${name}`),
);
await writeFile(join(releaseDir, "SHA256SUMS.txt"), `${checksums.join("\n")}\n`, "utf8");

const resumeEvidence = await createReleaseResumeEvidence(
  root,
  candidate,
  releaseResumeEvidencePaths(candidate, verification.commands),
);
await writeFile(
  join(output, "release-resume-evidence.json"),
  `${JSON.stringify(resumeEvidence, null, 2)}\n`,
  "utf8",
);

process.stdout.write(
  `${JSON.stringify({ releaseDir: relative(root, releaseDir), artifacts: checksumNames, testReport: "test-report/summary.json" }, null, 2)}\n`,
);

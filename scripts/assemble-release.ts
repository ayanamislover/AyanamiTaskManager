import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import Database from "better-sqlite3";

type Artifact = { name: string; bytes: number; sha256: string };
type Verification = {
  passed: boolean;
  completedAt: string;
  commands: Array<{
    name: string;
    command: string;
    exitCode: number;
    durationMs: number;
    log: string;
  }>;
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
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex")
    .toUpperCase();
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
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

function gitCommit(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "uncommitted";
}

function spdxId(name: string): string {
  return `SPDXRef-Package-${name.replace(/[^A-Za-z0-9.-]+/gu, "-")}`;
}

const output = join(root, "output");
const verification = await readJson<Verification>(join(output, "release-verification.json"));
if (!verification.passed) throw new Error("RELEASE_VERIFICATION_FAILED");
const e2e = await readJson<{ stats: Record<string, number> }>(join(output, "e2e", "results.json"));
const benchmark = await readJson<{ passed: boolean; metrics: Record<string, unknown> }>(
  join(output, "benchmark-report.json"),
);
const packagedSmoke = await readJson<{ passed: boolean; checks: Array<{ passed: boolean }> }>(
  join(output, "packaged-smoke-report.json"),
);
const portableSmoke = await readJson<{ passed: boolean; checks: Array<{ passed: boolean }> }>(
  join(output, "portable-smoke-report.json"),
);
const installedSmoke = await readJson<{ passed: boolean; checks: Array<{ passed: boolean }> }>(
  join(output, "installed-smoke-report.json"),
);
const distributionSmoke = await readJson<{ passed: boolean; checks: Array<{ passed: boolean }> }>(
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

const makeFiles = await filesBelow(join(root, "out", "make"));
const expectedSetupName =
  `AyanamiTaskManager-Setup-${packageJson.version}-win-x64.exe`.toLowerCase();
const expectedZipName = `AyanamiTaskManager-win32-x64-${packageJson.version}.zip`.toLowerCase();
const setupSource = makeFiles.find((path) => basename(path).toLowerCase() === expectedSetupName);
const zipSource = makeFiles.find((path) => basename(path).toLowerCase() === expectedZipName);
if (!setupSource || !zipSource) throw new Error("Forge make 产物不完整：缺少安装包或 zip");

await rm(releaseDir, { recursive: true, force: true });
await mkdir(releaseDir, { recursive: true });
const testReportDir = join(releaseDir, "test-report");
await mkdir(testReportDir, { recursive: true });

const setupName = `AyanamiTaskManager-Setup-${packageJson.version}-win-x64.exe`;
const portableName = `AyanamiTaskManager-${packageJson.version}-win-x64-portable.zip`;
await copyFile(setupSource, join(releaseDir, setupName));
await copyFile(zipSource, join(releaseDir, portableName));

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
const summary = {
  passed: true,
  completedAt: verification.completedAt,
  unitAndIntegration: {
    exitCode: verification.commands.find((entry) => entry.name === "test")?.exitCode,
    passed: vitestCount,
  },
  e2e: {
    exitCode: verification.commands.find((entry) => entry.name === "e2e")?.exitCode,
    passed: e2e.stats.expected,
    failed: e2e.stats.unexpected,
    flaky: e2e.stats.flaky,
  },
  packagedSmoke: { passed: true, checks: packagedSmoke.checks.length },
  portableSmoke: { passed: true, checks: portableSmoke.checks.length },
  installedSmoke: { passed: true, checks: installedSmoke.checks.length },
  distributionSmoke: { passed: true, checks: distributionSmoke.checks.length },
  benchmark: { passed: true, metrics: benchmark.metrics },
  screenshots: screenshots.map((name) => `screenshots/${name}`),
  commands: verification.commands,
  knownNonBlockingItems: [],
};
await writeFile(
  join(testReportDir, "summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
  "utf8",
);
await writeFile(
  join(testReportDir, "summary.md"),
  `# AyanamiTaskManager ${packageJson.version} 测试报告\n\n` +
    `- 结论：通过\n` +
    `- 单元/集成：${vitestCount} 项通过，退出码 0\n` +
    `- 桌面 E2E：${e2e.stats.expected} 项通过，失败 ${e2e.stats.unexpected}\n` +
    `- packaged smoke：${packagedSmoke.checks.length} 项通过\n` +
    `- portable smoke：${portableSmoke.checks.length} 项通过\n` +
    `- installed smoke：${installedSmoke.checks.length} 项通过\n` +
    `- benchmark：全部阈值通过\n` +
    `- 已知非阻塞剩余项：无\n\n` +
    `原始 JSON、命令日志和 1366/1920/3440 截图均位于本目录。\n`,
  "utf8",
);

const artifacts: Artifact[] = [];
for (const name of [setupName, portableName]) {
  const path = join(releaseDir, name);
  artifacts.push({ name, bytes: (await stat(path)).size, sha256: await digest(path) });
}

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
  commit: gitCommit(),
  builtAt: new Date().toISOString(),
  artifacts,
  testReport: { path: "test-report/summary.json", passed: true },
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

const checksumNames = [setupName, portableName, "release.json", "sbom.spdx.json"];
const checksums = await Promise.all(
  checksumNames.map(async (name) => `${await digest(join(releaseDir, name))}  ${name}`),
);
await writeFile(join(releaseDir, "SHA256SUMS.txt"), `${checksums.join("\n")}\n`, "utf8");

process.stdout.write(
  `${JSON.stringify({ releaseDir: relative(root, releaseDir), artifacts: checksumNames, testReport: "test-report/summary.json" }, null, 2)}\n`,
);

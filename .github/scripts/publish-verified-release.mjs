import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";

const runId = process.env.ATM_RELEASE_RUN;
const tag = process.env.ATM_RELEASE_TAG;
const head = process.env.ATM_RELEASE_SHA;
const reportHash = process.env.ATM_REPORT_SHA256;
const repo = process.env.GITHUB_REPOSITORY;
assert.match(runId ?? "", /^\d+$/u);
assert.match(tag ?? "", /^v\d+\.\d+\.\d+$/u);
assert.match(head ?? "", /^[a-f0-9]{40}$/u);
assert.match(reportHash ?? "", /^[a-f0-9]{64}$/u);
assert.match(repo ?? "", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
const version = tag.slice(1);
const verifyOnly = process.argv[2] === "--verify-only";
const root = resolve(verifyOnly ? process.argv[3] : "release-candidate");
const releaseRoot = join(root, "release");
const gh = (...args) =>
  execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    timeout: 15 * 60 * 1000,
  });
const api = (path) => JSON.parse(gh("api", `repos/${repo}/${path}`));
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
async function hash(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}
function safePath(name) {
  const normalized = name.replaceAll("\\", "/");
  const path = resolve(releaseRoot, normalized);
  assert.ok(path.startsWith(`${releaseRoot}${sep}`), "Evidence outside release directory");
  return path;
}

if (!verifyOnly) {
  const run = api(`actions/runs/${runId}`);
  assert.equal(run.status, "completed");
  assert.equal(run.conclusion, "success");
  assert.equal(run.head_sha, head);
  assert.equal(run.head_repository.full_name, repo);
  assert.equal(run.event, "workflow_dispatch");
  assert.equal(run.path, ".github/workflows/windows-release-validation.yml");
  gh(
    "run",
    "download",
    runId,
    "--repo",
    repo,
    "--name",
    `windows-release-validation-${runId}`,
    "--dir",
    root,
  );
}

const manifest = await readJson(join(releaseRoot, "release.json"));
const summary = await readJson(join(releaseRoot, "test-report/summary.json"));
const verification = await readJson(join(releaseRoot, "test-report/release-verification.json"));
assert.equal(manifest.version, version);
assert.equal(manifest.commit, head);
assert.equal(manifest.candidate.gitHead, head);
assert.deepEqual(summary.candidate, manifest.candidate);
assert.deepEqual(verification.fingerprint, manifest.candidate.fingerprint);
assert.equal(verification.fingerprint.gitHead, head);
assert.equal(verification.passed, true);
assert.equal(summary.highestVerifiedLevel, "INSTALLED_VERIFIED");
assert.deepEqual(
  summary.evidenceLayers.map((layer) => layer.level),
  ["SOURCE_DONE", "CI_VERIFIED", "PACKAGED_VERIFIED", "INSTALLED_VERIFIED"],
);
const stages = [
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
];
assert.equal(verification.commands.length, stages.length);
for (const stage of stages)
  assert.equal(verification.commands.find((item) => item.name === stage)?.exitCode, 0, stage);
for (const name of ["packaged", "portable", "installed", "distribution"]) {
  const report = await readJson(join(releaseRoot, `test-report/${name}-smoke-report.json`));
  assert.equal(report.passed, true, name);
  assert.ok(report.checks.length > 0, name);
  assert.ok(
    report.checks.every((check) => check.passed === true),
    name,
  );
}
const e2e = await readJson(join(releaseRoot, "test-report/e2e-results.json"));
assert.ok(e2e.stats.expected > 0);
assert.equal(e2e.stats.unexpected, 0);
assert.equal((await readJson(join(releaseRoot, "test-report/benchmark-report.json"))).passed, true);
for (const layer of summary.evidenceLayers) {
  assert.equal(layer.candidateSha256, manifest.candidate.candidateSha256);
  assert.ok(layer.evidence.length > 0);
  for (const evidence of layer.evidence) {
    // The assembler retains the source log directory in references, but copies
    // those same log bytes into test-report/logs. Validate bytes, not just labels.
    const name = evidence.path
      .replaceAll("\\", "/")
      .replace(/^test-report\/release-logs\//u, "test-report/logs/");
    assert.equal(await hash(safePath(name)), evidence.sha256.toLowerCase(), evidence.path);
  }
}
const expectedNames = [
  `AyanamiTaskManager-Setup-${version}-win-x64.exe`,
  `AyanamiTaskManager-${version}-win-x64-portable.zip`,
  `AyanamiTaskManagerDesktop-${version}-full.nupkg`,
  "RELEASES",
  "release.json",
  "sbom.spdx.json",
];
const checksums = (await readFile(join(releaseRoot, "SHA256SUMS.txt"), "utf8"))
  .trim()
  .split(/\r?\n/u);
const files = [];
for (const line of checksums) {
  const match = /^([a-fA-F0-9]{64})\s+(.+)$/u.exec(line);
  assert.ok(match, "Malformed checksum");
  const [, digest, name] = match;
  assert.equal(name, basename(name));
  assert.ok(expectedNames.includes(name));
  assert.ok(!files.some((file) => file.name === name), "Duplicate checksum");
  const path = safePath(name);
  assert.equal(await hash(path), digest.toLowerCase(), name);
  const bytes = (await stat(path)).size;
  const artifact = manifest.artifacts.find((item) => item.name === name);
  if (artifact) {
    assert.equal(artifact.sha256.toLowerCase(), digest.toLowerCase(), name);
    assert.equal(artifact.bytes, bytes, name);
  }
  files.push({ name, path, bytes, digest: `sha256:${digest.toLowerCase()}` });
}
assert.equal(files.length, expectedNames.length);
assert.equal(manifest.artifacts.length, 4);
for (const artifact of manifest.artifacts)
  assert.ok(files.some((file) => file.name === artifact.name));
files.push({
  name: "SHA256SUMS.txt",
  path: join(releaseRoot, "SHA256SUMS.txt"),
  bytes: (await stat(join(releaseRoot, "SHA256SUMS.txt"))).size,
  digest: `sha256:${await hash(join(releaseRoot, "SHA256SUMS.txt"))}`,
});
console.log(
  `Verified ${tag} at ${head}: all stages, smoke checks, evidence hashes and ${files.length} assets.`,
);
if (!verifyOnly) {
  const id = JSON.parse(
    gh("release", "view", tag, "--repo", repo, "--json", "databaseId"),
  ).databaseId;
  const release = api(`releases/${id}`);
  assert.equal(release.tag_name, tag);
  assert.equal(release.target_commitish, head);
  assert.equal(release.draft, true, "Only an existing draft may be published");
  assert.equal(release.prerelease, false);
  const reportName = `AyanamiTaskManager-${version}-test-report.zip`;
  const reportAsset = release.assets.find((asset) => asset.name === reportName);
  assert.equal(reportAsset?.state, "uploaded", "Attach the reviewed report ZIP first");
  assert.equal(reportAsset.digest, `sha256:${reportHash}`, reportName);
  assert.ok(reportAsset.size > 0);
  assert.ok(
    release.assets.every(
      (asset) => asset.name === reportName || files.some((file) => file.name === asset.name),
    ),
    "Unexpected draft attachment",
  );
  for (const file of files) {
    const existing = release.assets.find((asset) => asset.name === file.name);
    if (existing) {
      assert.equal(existing.state, "uploaded", file.name);
      assert.equal(existing.size, file.bytes, file.name);
      assert.equal(existing.digest, file.digest, file.name);
    } else {
      gh("release", "upload", tag, file.path, "--repo", repo);
    }
  }
  const uploaded = api(`releases/${id}`);
  assert.equal(uploaded.assets.length, files.length + 1);
  assert.equal(
    uploaded.assets.find((asset) => asset.name === reportName)?.digest,
    `sha256:${reportHash}`,
  );
  for (const file of files) {
    const asset = uploaded.assets.find((item) => item.name === file.name);
    assert.equal(asset?.state, "uploaded", file.name);
    assert.equal(asset.size, file.bytes, file.name);
    assert.equal(asset.digest, file.digest, file.name);
  }
  gh("release", "edit", tag, "--repo", repo, "--draft=false", "--latest");
  const published = api(`releases/${id}`);
  assert.equal(published.draft, false);
  const ref = api(`git/ref/tags/${tag}`);
  const taggedHead =
    ref.object.type === "tag" ? api(`git/tags/${ref.object.sha}`).object.sha : ref.object.sha;
  assert.equal(taggedHead, head);
  assert.equal(api("releases/latest").id, id);
  console.log(`Published ${published.html_url}`);
}

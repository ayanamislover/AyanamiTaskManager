import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  assertReleaseCandidateIdentity,
  type ReleaseArtifactIdentity,
  type ReleaseCandidateIdentity,
} from "./release-report.js";
import { releaseFingerprintsMatch, type ReleaseFingerprint } from "./release-fingerprint.js";

export type ReleaseEvidenceFileIdentity = {
  path: string;
  bytes: number;
  sha256: string;
};

export type ReleaseResumeEvidenceManifest = {
  schemaVersion: 1;
  candidateSha256: string;
  candidate: ReleaseCandidateIdentity;
  evidence: ReleaseEvidenceFileIdentity[];
};

export type ReleaseCommandLog = {
  log: string;
};

const FIXED_RESUME_EVIDENCE = [
  "output/release-verification.json",
  "output/e2e/results.json",
  "output/benchmark-report.json",
  "output/packaged-smoke-report.json",
  "output/portable-smoke-report.json",
  "output/distribution-smoke-report.json",
  "release/release.json",
  "release/sbom.spdx.json",
  "release/SHA256SUMS.txt",
] as const;

function normalizedRelativePath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    !normalized ||
    isAbsolute(path) ||
    /^[A-Za-z]:/u.test(normalized) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`RELEASE_EVIDENCE_PATH_INVALID: ${path}`);
  }
  return normalized;
}

function containedPath(root: string, path: string): string {
  const normalized = normalizedRelativePath(path);
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, ...normalized.split("/"));
  const below = relative(absoluteRoot, absolute);
  if (!below || below === ".." || below.startsWith(`..${sep}`) || isAbsolute(below)) {
    throw new Error(`RELEASE_EVIDENCE_PATH_OUTSIDE_ROOT: ${path}`);
  }
  return absolute;
}

async function fileIdentity(path: string): Promise<{ bytes: number; sha256: string }> {
  const digest = createHash("sha256");
  let bytes = 0;
  await new Promise<void>((resolveHash, rejectHash) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk: string | Buffer) => {
      bytes += Buffer.byteLength(chunk);
      digest.update(chunk);
    });
    stream.once("error", rejectHash);
    stream.once("end", resolveHash);
  });
  return { bytes, sha256: digest.digest("hex").toUpperCase() };
}

export async function identifyReleaseArtifact(
  path: string,
  name = basename(path),
): Promise<ReleaseArtifactIdentity> {
  return { name, ...(await fileIdentity(path)) };
}

export async function assertReleaseArtifact(
  path: string,
  expected: ReleaseArtifactIdentity,
): Promise<void> {
  if (basename(path).toLowerCase() !== expected.name.toLowerCase()) {
    throw new Error(`RELEASE_ARTIFACT_NAME_MISMATCH: ${expected.name}`);
  }
  const actual = await identifyReleaseArtifact(path, expected.name);
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256.toUpperCase()) {
    throw new Error(`RELEASE_ARTIFACT_IDENTITY_MISMATCH: ${expected.name}`);
  }
}

/**
 * 上一次发布验收里安装那一半是否真的做了：distribution-smoke 报告的 installed 字段。
 * 读不到或不是 "verified" 都按没做算——resume 证据里就不会要求 installed 报告，
 * 而 assemble 那边同样据此决定有没有 INSTALLED 层，两边口径一致。
 */
export function installedSmokeVerified(root = process.cwd()): boolean {
  try {
    const report = JSON.parse(
      readFileSync(join(root, "output", "distribution-smoke-report.json"), "utf8"),
    ) as { installed?: unknown };
    return report.installed === "verified";
  } catch {
    return false;
  }
}

/**
 * `installed`：这次的安装验收是否真的做了（distribution-smoke 报告的 installed 字段）。
 * 调用方必须明说——默认值会让「跳过」和「漏了 installed 报告」看起来一样。
 */
export function releaseResumeEvidencePaths(
  candidate: ReleaseCandidateIdentity,
  commands: readonly ReleaseCommandLog[],
  options: { installed: boolean },
): string[] {
  assertReleaseCandidateIdentity(candidate);
  const paths = [
    ...FIXED_RESUME_EVIDENCE,
    ...(options.installed ? ["output/installed-smoke-report.json"] : []),
    ...Object.values(candidate.artifacts).map((artifact) => `release/${artifact.name}`),
    ...commands.map((command) => `output/${normalizedRelativePath(command.log)}`),
  ].map(normalizedRelativePath);
  const unique = [...new Set(paths)].sort();
  if (unique.length !== paths.length) throw new Error("RELEASE_EVIDENCE_PATH_DUPLICATE");
  return unique;
}

export async function createReleaseResumeEvidence(
  root: string,
  candidate: ReleaseCandidateIdentity,
  requiredPaths: readonly string[],
): Promise<ReleaseResumeEvidenceManifest> {
  assertReleaseCandidateIdentity(candidate);
  const normalized = requiredPaths.map(normalizedRelativePath).sort();
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("RELEASE_EVIDENCE_PATH_DUPLICATE");
  }
  const evidence = await Promise.all(
    normalized.map(async (path) => ({ path, ...(await fileIdentity(containedPath(root, path))) })),
  );
  return {
    schemaVersion: 1,
    candidateSha256: candidate.candidateSha256,
    candidate,
    evidence,
  };
}

export async function assertReleaseResumeEvidence(
  root: string,
  manifest: ReleaseResumeEvidenceManifest,
  currentFingerprint: ReleaseFingerprint,
  requiredPaths: readonly string[],
): Promise<void> {
  if (manifest.schemaVersion !== 1) throw new Error("RELEASE_EVIDENCE_SCHEMA_INVALID");
  assertReleaseCandidateIdentity(manifest.candidate);
  if (
    manifest.candidateSha256 !== manifest.candidate.candidateSha256 ||
    !releaseFingerprintsMatch(manifest.candidate.fingerprint, currentFingerprint)
  ) {
    throw new Error("RELEASE_EVIDENCE_CANDIDATE_MISMATCH");
  }
  const expectedPaths = requiredPaths.map(normalizedRelativePath).sort();
  const actualPaths = manifest.evidence.map((item) => normalizedRelativePath(item.path)).sort();
  if (
    new Set(expectedPaths).size !== expectedPaths.length ||
    new Set(actualPaths).size !== actualPaths.length ||
    expectedPaths.length !== actualPaths.length ||
    expectedPaths.some((path, index) => path !== actualPaths[index])
  ) {
    throw new Error("RELEASE_EVIDENCE_SET_MISMATCH");
  }
  const evidenceByPath = new Map(manifest.evidence.map((item) => [item.path, item]));
  for (const path of expectedPaths) {
    const expected = evidenceByPath.get(path);
    if (!expected) throw new Error(`RELEASE_EVIDENCE_MISSING: ${path}`);
    const actual = await fileIdentity(containedPath(root, path));
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256.toUpperCase()) {
      throw new Error(`RELEASE_EVIDENCE_IDENTITY_MISMATCH: ${path}`);
    }
  }
}

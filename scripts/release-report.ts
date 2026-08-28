import { createHash } from "node:crypto";
import { STAGE_INPUTS, type ReleaseFingerprint } from "./release-fingerprint.js";

export {
  assertReleaseChecklistIsDynamic,
  releaseChecklistViolations,
} from "./release-checklist-contract.js";

export type StageDecisions = Record<string, { reuse: boolean; reason: string }>;

export const RELEASE_EVIDENCE_LEVELS = [
  "SOURCE_DONE",
  "CI_VERIFIED",
  "PACKAGED_VERIFIED",
  "INSTALLED_VERIFIED",
] as const;

export type ReleaseEvidenceLevel = (typeof RELEASE_EVIDENCE_LEVELS)[number];

export type ReleaseArtifactIdentity = {
  name: string;
  bytes: number;
  sha256: string;
};

export type ReleaseCandidateArtifacts = {
  setup: ReleaseArtifactIdentity;
  portable: ReleaseArtifactIdentity;
  upgradePackage: ReleaseArtifactIdentity;
  releases: ReleaseArtifactIdentity;
};

const RELEASE_CANDIDATE_ARTIFACT_KEYS = [
  "portable",
  "releases",
  "setup",
  "upgradePackage",
] as const;
const RELEASE_CANDIDATE_KEYS = [
  "artifacts",
  "candidateSha256",
  "fingerprint",
  "fingerprintSha256",
  "gitHead",
  "schemaVersion",
  "version",
] as const;

export type ReleaseCandidateIdentity = {
  schemaVersion: 2;
  version: string;
  gitHead: string;
  fingerprint: ReleaseFingerprint;
  fingerprintSha256: string;
  artifacts: ReleaseCandidateArtifacts;
  candidateSha256: string;
};

export type ReleaseEvidenceReference = {
  path: string;
  sha256: string;
};

export type ReleaseEvidenceLayer = {
  level: ReleaseEvidenceLevel;
  candidateSha256: string;
  verifiedAt: string;
  origin:
    | "source-checkout"
    | "local-ci-equivalent"
    | "github-actions"
    | "packaged-smoke"
    | "installed-smoke";
  evidence: ReleaseEvidenceReference[];
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex").toUpperCase();
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("RELEASE_IDENTITY_UNSERIALIZABLE");
  return encoded;
}

function normalizedArtifact(artifact: ReleaseArtifactIdentity): ReleaseArtifactIdentity {
  if (
    !artifact.name ||
    artifact.name === "." ||
    artifact.name === ".." ||
    /[\\/\0]/u.test(artifact.name) ||
    artifact.bytes <= 0 ||
    !Number.isSafeInteger(artifact.bytes)
  ) {
    throw new Error("RELEASE_ARTIFACT_IDENTITY_INVALID");
  }
  const digest = artifact.sha256.toUpperCase();
  if (!/^[A-F0-9]{64}$/u.test(digest)) throw new Error("RELEASE_ARTIFACT_HASH_INVALID");
  return { ...artifact, sha256: digest };
}

function assertFingerprintShape(fingerprint: ReleaseFingerprint): void {
  const expectedStageKeys = Object.keys(STAGE_INPUTS).sort();
  const actualStageKeys = Object.keys(fingerprint.stageHashes).sort();
  const hashes = [
    fingerprint.dirtyStateHash,
    fingerprint.sourceHash,
    fingerprint.lockfileHash,
    ...Object.values(fingerprint.stageHashes),
  ];
  if (
    fingerprint.version !== 2 ||
    fingerprint.dirty ||
    !/^[a-fA-F0-9]{40}$/u.test(fingerprint.gitHead) ||
    actualStageKeys.length !== expectedStageKeys.length ||
    actualStageKeys.some((key, index) => key !== expectedStageKeys[index]) ||
    hashes.some((hash) => !/^[a-fA-F0-9]{64}$/u.test(hash))
  ) {
    throw new Error("RELEASE_FINGERPRINT_INVALID");
  }
}

const EVIDENCE_ORIGINS: Record<ReleaseEvidenceLevel, ReleaseEvidenceLayer["origin"][]> = {
  SOURCE_DONE: ["source-checkout"],
  CI_VERIFIED: ["local-ci-equivalent", "github-actions"],
  PACKAGED_VERIFIED: ["packaged-smoke"],
  INSTALLED_VERIFIED: ["installed-smoke"],
};

function assertEvidenceReference(item: ReleaseEvidenceReference): void {
  const pathSegments = item.path.split(/[\\/]/u);
  if (
    !item.path ||
    /^(?:[A-Za-z]:[\\/]|[\\/])/u.test(item.path) ||
    pathSegments.includes("..") ||
    !/^[A-F0-9]{64}$/u.test(item.sha256.toUpperCase())
  ) {
    throw new Error("RELEASE_EVIDENCE_REFERENCE_INVALID");
  }
}

function assertEvidenceLayer(
  layer: ReleaseEvidenceLayer,
  candidate: ReleaseCandidateIdentity,
  index: number,
): void {
  if (
    layer.level !== RELEASE_EVIDENCE_LEVELS[index] ||
    layer.candidateSha256 !== candidate.candidateSha256
  ) {
    throw new Error("RELEASE_EVIDENCE_CANDIDATE_MISMATCH");
  }
  if (!EVIDENCE_ORIGINS[layer.level].includes(layer.origin)) {
    throw new Error("RELEASE_EVIDENCE_ORIGIN_INVALID");
  }
  if (!Number.isFinite(Date.parse(layer.verifiedAt))) {
    throw new Error("RELEASE_EVIDENCE_TIMESTAMP_INVALID");
  }
  if (layer.evidence.length === 0) throw new Error("RELEASE_EVIDENCE_EMPTY");
  for (const item of layer.evidence) assertEvidenceReference(item);
}

/**
 * 发布候选不是版本号或 HEAD 的别名。它绑定完整源码 fingerprint（含全部 stageHashes）
 * 和 Setup、portable、升级 NUPKG、RELEASES 的实际字节；任意一个字段变化都会
 * 得到不同 candidateSha256。
 */
export function createReleaseCandidateIdentity(input: {
  version: string;
  fingerprint: ReleaseFingerprint;
  artifacts: ReleaseCandidateArtifacts;
}): ReleaseCandidateIdentity {
  if (!input.version || input.fingerprint.gitHead.length === 0) {
    throw new Error("RELEASE_CANDIDATE_IDENTITY_INVALID");
  }
  assertFingerprintShape(input.fingerprint);
  const artifacts = {
    setup: normalizedArtifact(input.artifacts.setup),
    portable: normalizedArtifact(input.artifacts.portable),
    upgradePackage: normalizedArtifact(input.artifacts.upgradePackage),
    releases: normalizedArtifact(input.artifacts.releases),
  };
  const artifactNames = Object.values(artifacts).map((artifact) => artifact.name.toLowerCase());
  if (new Set(artifactNames).size !== artifactNames.length) {
    throw new Error("RELEASE_ARTIFACT_NAME_DUPLICATE");
  }
  const fingerprintSha256 = sha256(canonicalJson(input.fingerprint));
  const candidateSha256 = sha256(
    canonicalJson({
      schemaVersion: 2,
      version: input.version,
      gitHead: input.fingerprint.gitHead,
      fingerprintSha256,
      artifacts,
    }),
  );
  return {
    schemaVersion: 2,
    version: input.version,
    gitHead: input.fingerprint.gitHead,
    fingerprint: input.fingerprint,
    fingerprintSha256,
    artifacts,
    candidateSha256,
  };
}

export function assertReleaseCandidateIdentity(candidate: ReleaseCandidateIdentity): void {
  const runtimeCandidate = candidate as unknown as Record<string, unknown>;
  const candidateKeys = Object.keys(runtimeCandidate).sort();
  const artifactValue = runtimeCandidate.artifacts;
  const artifactKeys =
    artifactValue && typeof artifactValue === "object" ? Object.keys(artifactValue).sort() : [];
  if (
    runtimeCandidate.schemaVersion !== 2 ||
    candidateKeys.length !== RELEASE_CANDIDATE_KEYS.length ||
    candidateKeys.some((key, index) => key !== RELEASE_CANDIDATE_KEYS[index])
  ) {
    throw new Error("RELEASE_CANDIDATE_SCHEMA_INVALID");
  }
  if (
    artifactKeys.length !== RELEASE_CANDIDATE_ARTIFACT_KEYS.length ||
    artifactKeys.some((key, index) => key !== RELEASE_CANDIDATE_ARTIFACT_KEYS[index])
  ) {
    throw new Error("RELEASE_CANDIDATE_ARTIFACT_SET_INVALID");
  }
  const expected = createReleaseCandidateIdentity(candidate);
  if (
    candidate.gitHead !== candidate.fingerprint.gitHead ||
    candidate.fingerprintSha256 !== expected.fingerprintSha256 ||
    candidate.candidateSha256 !== expected.candidateSha256
  ) {
    throw new Error("RELEASE_CANDIDATE_FINGERPRINT_MISMATCH");
  }
}

/**
 * 证据层只能按固定顺序追加；同一份报告内所有层都必须绑定同一候选。这样源码绿、
 * CI 绿、打包烟测和安装烟测不会再被一个模糊的 passed 混成同一种事实。
 */
export function appendReleaseEvidenceLayer(
  current: readonly ReleaseEvidenceLayer[],
  candidate: ReleaseCandidateIdentity,
  next: Omit<ReleaseEvidenceLayer, "candidateSha256">,
): ReleaseEvidenceLayer[] {
  assertReleaseCandidateIdentity(candidate);
  const expected = RELEASE_EVIDENCE_LEVELS[current.length];
  if (!expected || next.level !== expected) {
    throw new Error(
      `RELEASE_EVIDENCE_LEVEL_SKIP: expected=${String(expected)} actual=${next.level}`,
    );
  }
  for (const [index, layer] of current.entries()) assertEvidenceLayer(layer, candidate, index);
  const appended: ReleaseEvidenceLayer = {
    ...next,
    candidateSha256: candidate.candidateSha256,
    evidence: next.evidence.map((item) => ({ ...item, sha256: item.sha256.toUpperCase() })),
  };
  assertEvidenceLayer(appended, candidate, current.length);
  return [...current, appended];
}

export function highestReleaseEvidenceLevel(
  layers: readonly ReleaseEvidenceLayer[],
): ReleaseEvidenceLevel | null {
  return layers.at(-1)?.level ?? null;
}

/**
 * 复用的阶段拿的是上一轮的报告。证据仍然成立——输入逐字节相同才会复用——但
 * 报告必须说出来：读 summary.md 的人分辨不出「本轮测的」和「上一轮测的」，
 * 就等于把没做的事写成做了。
 */
export function stageProvenance(stages: StageDecisions | undefined, stage: string): string {
  return stages?.[stage]?.reuse === true ? "（沿用同一候选的既有证据）" : "";
}

/** 清单只维护动态非阻塞项，发布数字和候选事实全部由 assembler 生成。 */
export function nonBlockingItems(checklist: string): string[] {
  const heading = "## 非阻塞项";
  const start = checklist.indexOf(heading);
  if (start < 0) throw new Error(`CHECKLIST_SECTION_MISSING: ${heading}`);
  const rest = checklist.slice(start + heading.length);
  const end = rest.indexOf("\n## ");
  return (end < 0 ? rest : rest.slice(0, end))
    .split(/\r?\n/u)
    .filter((line) => line.trimStart().startsWith("|"))
    .map((line) => line.split("|")[1]?.trim() ?? "")
    .filter((cell) => cell.length > 0 && !/^-+$/u.test(cell))
    .slice(1);
}

export function feedbackCloseoutStatusViolations(closeout: string): string[] {
  const allowed = new Set<ReleaseEvidenceLevel>(RELEASE_EVIDENCE_LEVELS);
  return closeout
    .split(/\r?\n/u)
    .filter((line) => /^\|\s*[^-|]/u.test(line))
    .map((line) => line.split("|")[2]?.trim() ?? "")
    .filter(
      (status) =>
        status === "DONE" ||
        (/^[A-Z_]+$/u.test(status) && !allowed.has(status as ReleaseEvidenceLevel)),
    );
}

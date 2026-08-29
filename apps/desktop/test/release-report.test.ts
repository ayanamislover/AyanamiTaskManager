import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STAGE_INPUTS, type ReleaseFingerprint } from "../../../scripts/release-fingerprint.js";
import {
  appendReleaseEvidenceLayer,
  assertReleaseCandidateIdentity,
  createReleaseCandidateIdentity,
  feedbackCloseoutStatusViolations,
  highestReleaseEvidenceLevel,
  nonBlockingItems,
  releaseChecklistViolations,
  stageProvenance,
  type ReleaseCandidateIdentity,
  type ReleaseCandidateArtifacts,
  type ReleaseEvidenceLayer,
  type ReleaseEvidenceLevel,
} from "../../../scripts/release-report.js";

const ROOT = process.cwd();
const CHECKLIST = readFileSync(join(ROOT, "docs", "release-checklist.md"), "utf8");
const CLOSEOUT = readFileSync(join(ROOT, "docs", "feedback-closeout.md"), "utf8");
const ASSEMBLER = readFileSync(join(ROOT, "scripts", "assemble-release.ts"), "utf8");
const HASH_A = "A".repeat(64);
const HASH_B = "B".repeat(64);

function fingerprint(overrides: Partial<ReleaseFingerprint> = {}): ReleaseFingerprint {
  return {
    version: 2,
    gitHead: "a".repeat(40),
    dirty: false,
    dirtyStateHash: HASH_A,
    sourceHash: HASH_B,
    lockfileHash: "C".repeat(64),
    stageHashes: Object.fromEntries(
      Object.keys(STAGE_INPUTS).map((stage, index) => [stage, String(index + 4).repeat(64)]),
    ),
    ...overrides,
  };
}

function candidate(overrides: Partial<ReleaseFingerprint> = {}): ReleaseCandidateIdentity {
  return createReleaseCandidateIdentity({
    version: "9.9.9",
    fingerprint: fingerprint(overrides),
    artifacts: candidateArtifacts(),
  });
}

function candidateArtifacts(
  overrides: Partial<ReleaseCandidateArtifacts> = {},
): ReleaseCandidateArtifacts {
  return {
    setup: { name: "Setup.exe", bytes: 42, sha256: HASH_A },
    portable: { name: "Portable.zip", bytes: 43, sha256: HASH_B },
    upgradePackage: { name: "Update-full.nupkg", bytes: 44, sha256: "C".repeat(64) },
    releases: { name: "RELEASES", bytes: 45, sha256: "D".repeat(64) },
    ...overrides,
  };
}

function append(
  layers: readonly ReleaseEvidenceLayer[],
  releaseCandidate: ReleaseCandidateIdentity,
  level: ReleaseEvidenceLevel,
): ReleaseEvidenceLayer[] {
  const origin: ReleaseEvidenceLayer["origin"] =
    level === "SOURCE_DONE"
      ? "source-checkout"
      : level === "CI_VERIFIED"
        ? "local-ci-equivalent"
        : level === "PACKAGED_VERIFIED"
          ? "packaged-smoke"
          : "installed-smoke";
  return appendReleaseEvidenceLayer(layers, releaseCandidate, {
    level,
    verifiedAt: "2026-08-28T00:00:00.000Z",
    origin,
    evidence: [{ path: `${level}.json`, sha256: HASH_A }],
  });
}

describe("发布候选身份", () => {
  it("绑定完整 fingerprint、全部 stage hash 与四种发行字节", () => {
    const base = candidate();
    expect(() => assertReleaseCandidateIdentity(base)).not.toThrow();

    const changed = [
      createReleaseCandidateIdentity({
        version: "9.9.8",
        fingerprint: fingerprint(),
        artifacts: candidateArtifacts(),
      }),
      candidate({ gitHead: "b".repeat(40) }),
      candidate({ dirtyStateHash: HASH_B }),
      candidate({ sourceHash: "F".repeat(64) }),
      candidate({ lockfileHash: "1".repeat(64) }),
      candidate({
        stageHashes: { ...fingerprint().stageHashes, e2e: "2".repeat(64) },
      }),
      createReleaseCandidateIdentity({
        version: "9.9.9",
        fingerprint: fingerprint(),
        artifacts: candidateArtifacts({
          setup: { name: "Setup.exe", bytes: 42, sha256: HASH_B },
        }),
      }),
      createReleaseCandidateIdentity({
        version: "9.9.9",
        fingerprint: fingerprint(),
        artifacts: candidateArtifacts({
          portable: { name: "Portable.zip", bytes: 43, sha256: HASH_A },
        }),
      }),
      createReleaseCandidateIdentity({
        version: "9.9.9",
        fingerprint: fingerprint(),
        artifacts: candidateArtifacts({
          upgradePackage: { name: "Update-full.nupkg", bytes: 44, sha256: HASH_A },
        }),
      }),
      createReleaseCandidateIdentity({
        version: "9.9.9",
        fingerprint: fingerprint(),
        artifacts: candidateArtifacts({
          releases: { name: "RELEASES", bytes: 45, sha256: HASH_A },
        }),
      }),
    ];
    expect(new Set(changed.map((entry) => entry.candidateSha256)).has(base.candidateSha256)).toBe(
      false,
    );
    const forged = { ...base, candidateSha256: HASH_B };
    expect(() => assertReleaseCandidateIdentity(forged)).toThrow(
      /RELEASE_CANDIDATE_FINGERPRINT_MISMATCH/u,
    );
    const manifestArtifactTamper = {
      ...base,
      artifacts: {
        ...base.artifacts,
        upgradePackage: { ...base.artifacts.upgradePackage, sha256: HASH_A },
      },
    };
    expect(() => assertReleaseCandidateIdentity(manifestArtifactTamper)).toThrow(
      /RELEASE_CANDIDATE_FINGERPRINT_MISMATCH/u,
    );
    expect(() =>
      assertReleaseCandidateIdentity({
        ...base,
        schemaVersion: 1,
      } as unknown as ReleaseCandidateIdentity),
    ).toThrow(/RELEASE_CANDIDATE_SCHEMA_INVALID/u);
    expect(() =>
      assertReleaseCandidateIdentity({
        ...base,
        artifacts: { ...base.artifacts, unexpected: base.artifacts.setup },
      } as unknown as ReleaseCandidateIdentity),
    ).toThrow(/RELEASE_CANDIDATE_ARTIFACT_SET_INVALID/u);
    const missingArtifact = {
      setup: base.artifacts.setup,
      portable: base.artifacts.portable,
      upgradePackage: base.artifacts.upgradePackage,
    };
    expect(() =>
      assertReleaseCandidateIdentity({
        ...base,
        artifacts: missingArtifact,
      } as unknown as ReleaseCandidateIdentity),
    ).toThrow(/RELEASE_CANDIDATE_ARTIFACT_SET_INVALID/u);
    expect(() => candidate({ dirty: true })).toThrow(/RELEASE_FINGERPRINT_INVALID/u);
    expect(() =>
      candidate({ stageHashes: { e2e: "D".repeat(64), benchmark: "E".repeat(64) } }),
    ).toThrow(/RELEASE_FINGERPRINT_INVALID/u);
    expect(() =>
      createReleaseCandidateIdentity({
        version: "9.9.9",
        fingerprint: fingerprint(),
        artifacts: candidateArtifacts({
          setup: { name: "../Setup.exe", bytes: 42, sha256: HASH_A },
        }),
      }),
    ).toThrow(/RELEASE_ARTIFACT_IDENTITY_INVALID/u);
  });
});

describe("发布证据层", () => {
  it("只允许 SOURCE→CI→PACKAGED→INSTALLED 单调推进", () => {
    const releaseCandidate = candidate();
    let layers: ReleaseEvidenceLayer[] = [];
    expect(() => append(layers, releaseCandidate, "CI_VERIFIED")).toThrow(
      /RELEASE_EVIDENCE_LEVEL_SKIP/u,
    );
    layers = append(layers, releaseCandidate, "SOURCE_DONE");
    expect(() => append(layers, releaseCandidate, "PACKAGED_VERIFIED")).toThrow(
      /RELEASE_EVIDENCE_LEVEL_SKIP/u,
    );
    layers = append(layers, releaseCandidate, "CI_VERIFIED");
    layers = append(layers, releaseCandidate, "PACKAGED_VERIFIED");
    layers = append(layers, releaseCandidate, "INSTALLED_VERIFIED");
    expect(layers.map((layer) => layer.level)).toEqual([
      "SOURCE_DONE",
      "CI_VERIFIED",
      "PACKAGED_VERIFIED",
      "INSTALLED_VERIFIED",
    ]);
    expect(highestReleaseEvidenceLevel(layers)).toBe("INSTALLED_VERIFIED");
    expect(() => append(layers, releaseCandidate, "INSTALLED_VERIFIED")).toThrow(
      /RELEASE_EVIDENCE_LEVEL_SKIP/u,
    );
  });

  it("候选改变、旧层被篡改或证据为空时拒绝推进", () => {
    const first = candidate();
    const second = createReleaseCandidateIdentity({
      version: first.version,
      fingerprint: first.fingerprint,
      artifacts: candidateArtifacts({
        setup: { ...first.artifacts.setup, sha256: HASH_B },
      }),
    });
    const source = append([], first, "SOURCE_DONE");
    expect(() => append(source, second, "CI_VERIFIED")).toThrow(
      /RELEASE_EVIDENCE_CANDIDATE_MISMATCH/u,
    );
    const corrupted = [{ ...source[0]!, candidateSha256: HASH_B }];
    expect(() => append(corrupted, first, "CI_VERIFIED")).toThrow(
      /RELEASE_EVIDENCE_CANDIDATE_MISMATCH/u,
    );
    expect(() =>
      appendReleaseEvidenceLayer([], first, {
        level: "SOURCE_DONE",
        verifiedAt: "2026-08-28T00:00:00.000Z",
        origin: "source-checkout",
        evidence: [],
      }),
    ).toThrow(/RELEASE_EVIDENCE_EMPTY/u);

    for (const tampered of [
      [{ ...source[0]!, origin: "github-actions" as const }],
      [{ ...source[0]!, verifiedAt: "not-a-time" }],
      [{ ...source[0]!, evidence: [{ path: "../outside.json", sha256: HASH_A }] }],
      [{ ...source[0]!, evidence: [{ path: "source.json", sha256: "bad" }] }],
    ]) {
      expect(() => append(tampered, first, "CI_VERIFIED")).toThrow(/RELEASE_EVIDENCE_/u);
    }
  });
});

describe("发布报告的证据出处", () => {
  it("复用的阶段在报告里标明，重跑的不标", () => {
    const stages = {
      e2e: { reuse: true, reason: "fingerprint-match" },
      benchmark: { reuse: false, reason: "resume-not-requested" },
    };
    expect(stageProvenance(stages, "e2e")).toBe("（沿用同一候选的既有证据）");
    expect(stageProvenance(stages, "benchmark")).toBe("");
    expect(stageProvenance(undefined, "e2e")).toBe("");
  });

  it("assembler 按四层生成 summary，不再写混合 passed", () => {
    const summaryBody = /const summary = \{(?<body>[\s\S]*?)\n\};/u.exec(ASSEMBLER)?.groups?.body;
    expect(summaryBody).toBeDefined();
    expect(summaryBody).toContain("evidenceLayers");
    expect(summaryBody).toContain("highestVerifiedLevel");
    expect(summaryBody).not.toMatch(/^\s*passed:\s*true/mu);
    expect(ASSEMBLER).toContain("GITHUB_CANDIDATE_SHA_MISMATCH");
    expect(ASSEMBLER).toContain("RELEASE_VERIFICATION_COMMANDS_INVALID");
    expect(ASSEMBLER).toContain("TEST_REPORT_COUNT_INVALID");
    expect(ASSEMBLER).not.toMatch(/testReport:\s*\{[^}]*passed:/u);
    for (const level of ["SOURCE_DONE", "CI_VERIFIED", "PACKAGED_VERIFIED", "INSTALLED_VERIFIED"]) {
      expect(ASSEMBLER).toContain(`level: "${level}"`);
    }
  });

  it("assembler 从已通过烟测的发行程序读取 Electron ABI", () => {
    expect(ASSEMBLER).toMatch(
      /join\(\s*root,\s*"out",\s*"AyanamiTaskManager-win32-x64",\s*"AyanamiTaskManager\.exe"/u,
    );
    expect(ASSEMBLER).not.toContain('join(root, "node_modules", "electron", "dist"');
    expect(ASSEMBLER).toContain("if (probe.error)");
  });
});

describe("动态发布文档守卫", () => {
  it("清单不手填勾选、测试/性能数字或候选哈希", () => {
    expect(releaseChecklistViolations(CHECKLIST)).toEqual([]);
    const bad = [
      "- [x] pnpm test",
      "单元测试 452 项通过",
      "服务 RSS <= 150 MB",
      `Git HEAD: ${"A".repeat(40)}`,
    ].join("\n");
    expect(releaseChecklistViolations(bad)).toEqual([
      "MANUAL_CHECKMARK",
      "MANUAL_TEST_COUNT",
      "MANUAL_PERFORMANCE_NUMBER",
      "MANUAL_CANDIDATE_HASH",
    ]);
  });

  it("closeout 只使用四层状态，不再混写裸 DONE", () => {
    expect(feedbackCloseoutStatusViolations(CLOSEOUT)).toEqual([]);
    expect(feedbackCloseoutStatusViolations("| P0-1 | DONE | x |")).toEqual(["DONE"]);
    expect(feedbackCloseoutStatusViolations("| P0-1 | SOMETHING_ELSE | x |")).toEqual([
      "SOMETHING_ELSE",
    ]);
  });
});

describe("已知非阻塞项", () => {
  it("从通用清单表格读条目，跳过表头与分隔行", () => {
    const markdown = [
      "## 非阻塞项",
      "",
      "| 条目 | 缺口 |",
      "| ---- | ---- |",
      "| 甲 | 没有用例 |",
      "| 乙 | 没有断言 |",
      "",
      "## 下一节",
      "| 不该读到 | x |",
    ].join("\n");
    expect(nonBlockingItems(markdown)).toEqual(["甲", "乙"]);
  });

  it("真实清单显式为空，缺少小节时 fail closed", () => {
    expect(nonBlockingItems(CHECKLIST)).toEqual([]);
    expect(() => nonBlockingItems("## 其他\n")).toThrow(/CHECKLIST_SECTION_MISSING/u);
  });
});

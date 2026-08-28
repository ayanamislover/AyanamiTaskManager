import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertReleaseArtifact,
  assertReleaseResumeEvidence,
  createReleaseResumeEvidence,
  identifyReleaseArtifact,
  releaseResumeEvidencePaths,
} from "../../../scripts/release-artifact-evidence.js";
import { STAGE_INPUTS, type ReleaseFingerprint } from "../../../scripts/release-fingerprint.js";
import {
  createReleaseCandidateIdentity,
  type ReleaseCandidateIdentity,
} from "../../../scripts/release-report.js";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fingerprint(): ReleaseFingerprint {
  return {
    version: 2,
    gitHead: "a".repeat(40),
    dirty: false,
    dirtyStateHash: "A".repeat(64),
    sourceHash: "B".repeat(64),
    lockfileHash: "C".repeat(64),
    stageHashes: Object.fromEntries(
      Object.keys(STAGE_INPUTS).map((stage, index) => [stage, String(index + 4).repeat(64)]),
    ),
  };
}

async function fixtureCandidate(root: string): Promise<ReleaseCandidateIdentity> {
  const release = join(root, "release");
  mkdirSync(release, { recursive: true });
  const names = ["Setup.exe", "Portable.zip", "Update-full.nupkg", "RELEASES"] as const;
  for (const [index, name] of names.entries()) {
    writeFileSync(join(release, name), `artifact-${index}\n`, "utf8");
  }
  return createReleaseCandidateIdentity({
    version: "9.9.9",
    fingerprint: fingerprint(),
    artifacts: {
      setup: await identifyReleaseArtifact(join(release, names[0])),
      portable: await identifyReleaseArtifact(join(release, names[1])),
      upgradePackage: await identifyReleaseArtifact(join(release, names[2])),
      releases: await identifyReleaseArtifact(join(release, names[3])),
    },
  });
}

describe("发布制品身份", () => {
  it("实际字节、大小或文件名变化均拒绝", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-release-artifact-"));
    temporary.push(root);
    const candidate = await fixtureCandidate(root);
    for (const expected of [candidate.artifacts.setup, candidate.artifacts.upgradePackage]) {
      const path = join(root, "release", expected.name);
      await expect(assertReleaseArtifact(path, expected)).resolves.toBeUndefined();
      writeFileSync(path, "tampered\n", "utf8");
      await expect(assertReleaseArtifact(path, expected)).rejects.toThrow(
        /RELEASE_ARTIFACT_IDENTITY_MISMATCH/u,
      );
    }
    await expect(
      assertReleaseArtifact(
        join(root, "release", candidate.artifacts.portable.name),
        candidate.artifacts.setup,
      ),
    ).rejects.toThrow(/RELEASE_ARTIFACT_NAME_MISMATCH/u);
  });
});

describe("resume 证据字节闭包", () => {
  it("报告或日志任一字节变化、证据缺失/增补都拒绝", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-release-evidence-"));
    temporary.push(root);
    const candidate = await fixtureCandidate(root);
    mkdirSync(join(root, "output", "release-logs"), { recursive: true });
    writeFileSync(join(root, "output", "report.json"), '{"passed":true}\n', "utf8");
    writeFileSync(join(root, "output", "release-logs", "test.log"), "green\n", "utf8");
    const required = [
      "output/report.json",
      "output/release-logs/test.log",
      `release/${candidate.artifacts.setup.name}`,
      `release/${candidate.artifacts.portable.name}`,
    ];
    const manifest = await createReleaseResumeEvidence(root, candidate, required);
    await expect(
      assertReleaseResumeEvidence(root, manifest, fingerprint(), required),
    ).resolves.toBeUndefined();

    writeFileSync(join(root, "output", "release-logs", "test.log"), "red\n", "utf8");
    await expect(
      assertReleaseResumeEvidence(root, manifest, fingerprint(), required),
    ).rejects.toThrow(/RELEASE_EVIDENCE_IDENTITY_MISMATCH/u);
    writeFileSync(join(root, "output", "release-logs", "test.log"), "green\n", "utf8");

    await expect(
      assertReleaseResumeEvidence(
        root,
        { ...manifest, evidence: manifest.evidence.slice(1) },
        fingerprint(),
        required,
      ),
    ).rejects.toThrow(/RELEASE_EVIDENCE_SET_MISMATCH/u);
    await expect(
      assertReleaseResumeEvidence(root, manifest, fingerprint(), [...required, "extra.json"]),
    ).rejects.toThrow(/RELEASE_EVIDENCE_SET_MISMATCH/u);
  });

  it("稳定证据清单覆盖四种制品、所有报告和每条命令日志", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-release-evidence-set-"));
    temporary.push(root);
    const candidate = await fixtureCandidate(root);
    const paths = releaseResumeEvidencePaths(candidate, [
      { log: "release-logs/lint.log" },
      { log: "release-logs/test.log" },
    ]);
    for (const artifact of Object.values(candidate.artifacts)) {
      expect(paths).toContain(`release/${artifact.name}`);
    }
    for (const report of [
      "output/release-verification.json",
      "output/e2e/results.json",
      "output/benchmark-report.json",
      "output/packaged-smoke-report.json",
      "output/portable-smoke-report.json",
      "output/installed-smoke-report.json",
      "output/distribution-smoke-report.json",
      "release/release.json",
      "release/sbom.spdx.json",
      "release/SHA256SUMS.txt",
    ]) {
      expect(paths).toContain(report);
    }
    expect(paths).toContain("output/release-logs/lint.log");
    expect(paths).toContain("output/release-logs/test.log");

    for (const path of paths) {
      const absolute = join(root, ...path.split("/"));
      mkdirSync(dirname(absolute), { recursive: true });
      if (!existsSync(absolute)) writeFileSync(absolute, `evidence:${path}\n`, "utf8");
    }
    const manifest = await createReleaseResumeEvidence(root, candidate, paths);
    for (const path of paths) {
      const absolute = join(root, ...path.split("/"));
      const original = readFileSync(absolute);
      writeFileSync(absolute, `tampered:${path}\n`, "utf8");
      await expect(
        assertReleaseResumeEvidence(root, manifest, fingerprint(), paths),
        path,
      ).rejects.toThrow(/RELEASE_EVIDENCE_IDENTITY_MISMATCH/u);
      writeFileSync(absolute, original);
    }
  });
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitReleasePreparation,
  computeReleaseFingerprint,
  decideReleaseResume,
  parseReleaseRunMode,
  releaseFingerprintsMatch,
  selectReusableReleaseCommands,
  STAGE_INPUTS,
  verifyReleaseSource,
  type ReleaseFingerprint,
} from "../../../scripts/release-fingerprint.js";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function cloneFingerprint(fingerprint: ReleaseFingerprint): ReleaseFingerprint {
  return JSON.parse(JSON.stringify(fingerprint)) as ReleaseFingerprint;
}

describe("release --resume 输入指纹", () => {
  it("--full 明确表示零复用，未知或冲突参数 fail closed", () => {
    expect(parseReleaseRunMode([])).toBe("standard");
    expect(parseReleaseRunMode(["--resume"])).toBe("resume");
    expect(parseReleaseRunMode(["--full"])).toBe("full");
    expect(() => parseReleaseRunMode(["--resume", "--full"])).toThrow(/RELEASE_ARGUMENT_CONFLICT/u);
    expect(() => parseReleaseRunMode(["--fast"])).toThrow(/RELEASE_ARGUMENT_UNKNOWN/u);

    const fullDecision = {
      reuse: false,
      reason: "full-run-requested" as const,
    };
    expect([
      ...selectReusableReleaseCommands(fullDecision, [{ name: "e2e", exitCode: 0 }]).keys(),
    ]).toEqual([]);
  });

  it("仅在源码输入完全相同时复用旧绿灯", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-release-fingerprint-"));
    temporary.push(root);
    git(root, "init", "--quiet");
    git(root, "config", "user.email", "atm-test@example.invalid");
    git(root, "config", "user.name", "ATM Test");
    writeFileSync(join(root, "app.ts"), "export const value = 1;\n", "utf8");
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    git(root, "add", ".");
    git(root, "commit", "--quiet", "-m", "initial");

    const previous = await computeReleaseFingerprint(root);
    expect(releaseFingerprintsMatch(previous, await computeReleaseFingerprint(root))).toBe(true);

    writeFileSync(join(root, "app.ts"), "export const value = 2;\n", "utf8");
    expect(releaseFingerprintsMatch(previous, await computeReleaseFingerprint(root))).toBe(false);
  });

  it("对 lockfile 变化给出可审计的拒绝复用原因", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-release-lockfile-"));
    temporary.push(root);
    git(root, "init", "--quiet");
    git(root, "config", "user.email", "atm-test@example.invalid");
    git(root, "config", "user.name", "ATM Test");
    writeFileSync(join(root, "app.ts"), "export const value = 1;\n", "utf8");
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    git(root, "add", ".");
    git(root, "commit", "--quiet", "-m", "initial");

    const previous = await computeReleaseFingerprint(root);
    expect(decideReleaseResume(true, previous, await computeReleaseFingerprint(root))).toEqual({
      reuse: true,
      reason: "fingerprint-match",
    });

    writeFileSync(
      join(root, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: false\n",
      "utf8",
    );
    expect(decideReleaseResume(true, previous, await computeReleaseFingerprint(root))).toEqual({
      reuse: false,
      reason: "fingerprint-mismatch",
    });
  });

  it("逐字段篡改都拒绝复用，stageHashes 也是完整指纹的一部分", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-release-field-tamper-"));
    temporary.push(root);
    git(root, "init", "--quiet");
    git(root, "config", "user.email", "atm-test@example.invalid");
    git(root, "config", "user.name", "ATM Test");
    writeFileSync(join(root, "app.ts"), "export const value = 1;\n", "utf8");
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    git(root, "add", ".");
    git(root, "commit", "--quiet", "-m", "initial");

    const current = await computeReleaseFingerprint(root);
    const mutations: Array<[string, (copy: ReleaseFingerprint) => void]> = [
      ["version", (copy) => ((copy as { version: number }).version = 999)],
      ["gitHead", (copy) => (copy.gitHead = `${copy.gitHead}-tampered`)],
      ["dirty", (copy) => (copy.dirty = !copy.dirty)],
      ["dirtyStateHash", (copy) => (copy.dirtyStateHash = "TAMPERED")],
      ["sourceHash", (copy) => (copy.sourceHash = "TAMPERED")],
      ["lockfileHash", (copy) => (copy.lockfileHash = "TAMPERED")],
      [
        "stageHashes",
        (copy) => {
          const firstStage = Object.keys(STAGE_INPUTS)[0]!;
          copy.stageHashes[firstStage] = "TAMPERED";
        },
      ],
    ];

    for (const [field, mutate] of mutations) {
      const previous = cloneFingerprint(current);
      mutate(previous);
      expect(releaseFingerprintsMatch(previous, current), field).toBe(false);
      expect(decideReleaseResume(true, previous, current), field).toEqual({
        reuse: false,
        reason: "fingerprint-mismatch",
      });
    }
  });

  it("stageHashes 缺失、键集增减或任一值变化都拒绝复用", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-release-stage-set-"));
    temporary.push(root);
    git(root, "init", "--quiet");
    git(root, "config", "user.email", "atm-test@example.invalid");
    git(root, "config", "user.name", "ATM Test");
    writeFileSync(join(root, "app.ts"), "export const value = 1;\n", "utf8");
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    git(root, "add", ".");
    git(root, "commit", "--quiet", "-m", "initial");

    const current = await computeReleaseFingerprint(root);
    const firstStage = Object.keys(STAGE_INPUTS)[0]!;
    const malformed: ReleaseFingerprint[] = [];

    const missingMap = cloneFingerprint(current) as ReleaseFingerprint & {
      stageHashes?: Record<string, string>;
    };
    delete missingMap.stageHashes;
    malformed.push(missingMap as ReleaseFingerprint);

    const missingKey = cloneFingerprint(current);
    delete missingKey.stageHashes[firstStage];
    malformed.push(missingKey);

    const extraKey = cloneFingerprint(current);
    extraKey.stageHashes["unexpected-stage"] = "EXTRA";
    malformed.push(extraKey);

    for (const stage of Object.keys(STAGE_INPUTS)) {
      const changedValue = cloneFingerprint(current);
      changedValue.stageHashes[stage] = `${changedValue.stageHashes[stage]}-tampered`;
      malformed.push(changedValue);
    }

    for (const previous of malformed) {
      expect(releaseFingerprintsMatch(previous, current)).toBe(false);
    }

    const currentMissingKey = cloneFingerprint(current);
    delete currentMissingKey.stageHashes[firstStage];
    expect(releaseFingerprintsMatch(current, currentMissingKey)).toBe(false);
  });

  it("完整 fingerprint mismatch 时旧绿灯零复用，不能由相同 stageHash 绕过", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-release-zero-reuse-"));
    temporary.push(root);
    git(root, "init", "--quiet");
    git(root, "config", "user.email", "atm-test@example.invalid");
    git(root, "config", "user.name", "ATM Test");
    writeFileSync(join(root, "app.ts"), "export const value = 1;\n", "utf8");
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    git(root, "add", ".");
    git(root, "commit", "--quiet", "-m", "initial");

    const current = await computeReleaseFingerprint(root);
    const previous = cloneFingerprint(current);
    previous.sourceHash = "TOP_LEVEL_MISMATCH_WITH_STAGE_HASHES_UNCHANGED";
    const decision = decideReleaseResume(true, previous, current);
    expect(decision).toEqual({ reuse: false, reason: "fingerprint-mismatch" });
    expect([
      ...selectReusableReleaseCommands(decision, [
        { name: "e2e", exitCode: 0 },
        { name: "benchmark", exitCode: 0 },
        { name: "distribution-smoke", exitCode: 0 },
      ]).keys(),
    ]).toEqual([]);
  });
});

describe("发布源码溯源", () => {
  it("只接受 package 版本可从 clean HEAD 直接检出的构建输入", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-release-source-"));
    temporary.push(root);
    git(root, "init", "--quiet");
    git(root, "config", "user.email", "atm-test@example.invalid");
    git(root, "config", "user.name", "ATM Test");
    writeFileSync(join(root, "package.json"), '{"version":"1.0.0"}\n', "utf8");
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    git(root, "add", ".");
    git(root, "commit", "--quiet", "-m", "release 1.0.0");

    const clean = await computeReleaseFingerprint(root);
    await expect(verifyReleaseSource(root, clean)).resolves.toMatchObject({
      version: "1.0.0",
      gitHead: clean.gitHead,
      dirty: false,
      dirtyStateHash: clean.dirtyStateHash,
      sourceHash: clean.sourceHash,
      lockfileHash: clean.lockfileHash,
    });

    writeFileSync(join(root, "package.json"), '{"version":"1.0.1"}\n', "utf8");
    const dirty = await computeReleaseFingerprint(root);
    await expect(verifyReleaseSource(root, dirty)).rejects.toThrow(/RELEASE_SOURCE_DIRTY/u);
  });

  it("升版准备先形成可检出的 clean HEAD，再允许进入构建", async () => {
    const root = mkdtempSync(join(tmpdir(), "atm-release-commit-"));
    temporary.push(root);
    git(root, "init", "--quiet");
    git(root, "config", "user.email", "atm-test@example.invalid");
    git(root, "config", "user.name", "ATM Test");
    writeFileSync(join(root, "package.json"), '{"version":"1.0.0"}\n', "utf8");
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    git(root, "add", ".");
    git(root, "commit", "--quiet", "-m", "initial");

    writeFileSync(join(root, "package.json"), '{"version":"1.0.1"}\n', "utf8");
    const head = commitReleasePreparation(root, "1.0.1", ["package.json"]);

    expect(
      execFileSync("git", ["show", `${head}:package.json`], { cwd: root, encoding: "utf8" }),
    ).toContain('"version":"1.0.1"');
    expect(execFileSync("git", ["status", "--porcelain=v1"], { cwd: root, encoding: "utf8" })).toBe(
      "",
    );
    await expect(
      verifyReleaseSource(root, await computeReleaseFingerprint(root)),
    ).resolves.toMatchObject({ version: "1.0.1", gitHead: head, dirty: false });
  });
});

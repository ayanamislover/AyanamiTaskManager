import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeReleaseFingerprint,
  decideReleaseResume,
  releaseFingerprintsMatch,
} from "../../../scripts/release-fingerprint.js";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

describe("release --resume 输入指纹", () => {
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
});

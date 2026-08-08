import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type ReleaseFingerprint = {
  version: 1;
  gitHead: string;
  dirty: boolean;
  dirtyStateHash: string;
  sourceHash: string;
  lockfileHash: string;
};

export type ReleaseResumeDecision = {
  reuse: boolean;
  reason:
    | "resume-not-requested"
    | "previous-report-missing-fingerprint"
    | "fingerprint-match"
    | "fingerprint-mismatch";
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex").toUpperCase();
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

async function sourceHash(root: string, files: string[]): Promise<string> {
  const digest = createHash("sha256");
  for (const file of files.filter((path) => path !== "pnpm-lock.yaml").sort()) {
    digest.update(file);
    digest.update("\0");
    try {
      digest.update(await readFile(join(root, file)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      digest.update("<missing>");
    }
    digest.update("\0");
  }
  return digest.digest("hex").toUpperCase();
}

export async function computeReleaseFingerprint(root: string): Promise<ReleaseFingerprint> {
  const gitHead = git(root, ["rev-parse", "HEAD"]).trim();
  const dirtyState = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const files = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean);
  return {
    version: 1,
    gitHead,
    dirty: dirtyState.length > 0,
    dirtyStateHash: sha256(dirtyState),
    sourceHash: await sourceHash(root, files),
    lockfileHash: sha256(await readFile(join(root, "pnpm-lock.yaml"))),
  };
}

export function releaseFingerprintsMatch(
  previous: ReleaseFingerprint | null | undefined,
  current: ReleaseFingerprint,
): boolean {
  if (!previous) return false;
  return (
    previous.version === current.version &&
    previous.gitHead === current.gitHead &&
    previous.dirty === current.dirty &&
    previous.dirtyStateHash === current.dirtyStateHash &&
    previous.sourceHash === current.sourceHash &&
    previous.lockfileHash === current.lockfileHash
  );
}

export function decideReleaseResume(
  resumeRequested: boolean,
  previous: ReleaseFingerprint | null | undefined,
  current: ReleaseFingerprint,
): ReleaseResumeDecision {
  if (!resumeRequested) return { reuse: false, reason: "resume-not-requested" };
  if (!previous) return { reuse: false, reason: "previous-report-missing-fingerprint" };
  return releaseFingerprintsMatch(previous, current)
    ? { reuse: true, reason: "fingerprint-match" }
    : { reuse: false, reason: "fingerprint-mismatch" };
}

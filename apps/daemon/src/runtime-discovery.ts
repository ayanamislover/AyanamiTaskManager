import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { noteSuppressed } from "@ayanami-task/errors";
import { isDifferentProcess, readProcessIdentity } from "./process-identity.js";

export const DAEMON_VERSION = "1.2.2";
export const DAEMON_RUNTIME_FILENAME = "daemon.json";
export const LEGACY_TOKEN_FILENAME = "local.token";
export const DAEMON_LOCK_FILENAME = "daemon.lock";

export type DaemonRuntimeDescriptor = {
  endpoint: string;
  token: string;
  pid: number;
  instanceId: string;
  version: string;
  startedAt: string;
};

export type DaemonRuntimeLease = {
  readonly instanceId: string;
  publish(descriptor: DaemonRuntimeDescriptor): string;
  clear(): void;
  release(): void;
};

export function resolveDaemonDataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ATM_DATA_DIR ?? env.AYANAMI_TASK_DATA_DIR;
  if (explicit) return resolve(explicit);
  if (!env.LOCALAPPDATA) throw new Error("ATM_DATA_DIRECTORY_UNAVAILABLE");
  return join(env.LOCALAPPDATA, "AyanamiTaskManager");
}

function validLoopbackEndpoint(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function runtimeDescriptor(value: unknown): DaemonRuntimeDescriptor | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<DaemonRuntimeDescriptor>;
  if (
    !validLoopbackEndpoint(candidate.endpoint) ||
    typeof candidate.token !== "string" ||
    candidate.token.length === 0 ||
    candidate.token.length > 512 ||
    !Number.isSafeInteger(candidate.pid) ||
    Number(candidate.pid) <= 0 ||
    typeof candidate.instanceId !== "string" ||
    !/^[a-f0-9]{32}$/u.test(candidate.instanceId) ||
    typeof candidate.version !== "string" ||
    candidate.version.length === 0 ||
    typeof candidate.startedAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.startedAt))
  )
    return null;
  return candidate as DaemonRuntimeDescriptor;
}

export function createDaemonToken(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.AYANAMI_TASK_TOKEN?.trim();
  return configured || randomBytes(32).toString("base64url");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function acquireDaemonRuntime(runtimeDir: string, pid = process.pid): DaemonRuntimeLease {
  mkdirSync(runtimeDir, { recursive: true });
  const lockPath = join(runtimeDir, DAEMON_LOCK_FILENAME);
  const nonce = randomBytes(16).toString("hex");
  const processIdentity = readProcessIdentity(pid);
  const content = `${JSON.stringify({ pid, nonce, processIdentity })}\n`;
  const ownsLease = () => {
    try {
      return readFileSync(lockPath, "utf8") === content;
    } catch {
      return false;
    }
  };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      writeFileSync(lockPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      return {
        instanceId: nonce,
        publish(descriptor) {
          if (!ownsLease()) throw new Error("ATM_RUNTIME_LEASE_LOST");
          if (descriptor.instanceId !== nonce || descriptor.pid !== pid)
            throw new Error("ATM_RUNTIME_LEASE_MISMATCH");
          return publishDaemonRuntime(runtimeDir, descriptor);
        },
        clear() {
          if (!ownsLease()) throw new Error("ATM_RUNTIME_LEASE_LOST");
          rmSync(join(runtimeDir, DAEMON_RUNTIME_FILENAME), { force: true });
        },
        release() {
          if (ownsLease()) rmSync(lockPath, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw new Error("ATM_RUNTIME_LOCK_FAILED");
    }
    let ownerPid = 0;
    let ownerIdentity: unknown;
    let modifiedAt = Number.NaN;
    let observedLock = "";
    try {
      observedLock = readFileSync(lockPath, "utf8");
      modifiedAt = statSync(lockPath).mtimeMs;
      const owner = JSON.parse(observedLock) as { pid?: unknown; processIdentity?: unknown };
      if (Number.isSafeInteger(owner.pid)) ownerPid = Number(owner.pid);
      ownerIdentity = owner.processIdentity;
    } catch {
      // Malformed locks are stale and are quarantined below.
    }
    if (
      ownerPid > 0 &&
      processAlive(ownerPid) &&
      !isDifferentProcess(ownerIdentity, readProcessIdentity(ownerPid), modifiedAt)
    )
      throw new Error("ATM_RUNTIME_ALREADY_ACTIVE");
    const stalePath = `${lockPath}.stale-${pid}-${nonce}-${attempt}`;
    try {
      // Identity lookup can take time. A changed owner must be reconsidered, not quarantined.
      if (readFileSync(lockPath, "utf8") !== observedLock) continue;
      // Atomic rename lets only one contender quarantine a stale lock. No
      // contender can accidentally unlink a fresh successor lock.
      renameSync(lockPath, stalePath);
      rmSync(stalePath, { force: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "EEXIST") throw new Error("ATM_RUNTIME_LOCK_FAILED");
    }
  }
  throw new Error("ATM_RUNTIME_LOCK_FAILED");
}

export function readDaemonRuntime(runtimeDir: string): DaemonRuntimeDescriptor {
  try {
    const parsed = JSON.parse(
      readFileSync(join(runtimeDir, DAEMON_RUNTIME_FILENAME), "utf8"),
    ) as unknown;
    const descriptor = runtimeDescriptor(parsed);
    if (descriptor) return descriptor;
  } catch {
    // The public error deliberately carries neither the path nor descriptor contents.
  }
  throw new Error("ATM_RUNTIME_UNAVAILABLE");
}

const HELD_OPEN_RENAME_ERRORS = new Set(["EACCES", "EBUSY", "EPERM"]);
const REPLACE_ATTEMPTS = 8;

/**
 * Replace `target` with `content` in one rename, so a reader sees the previous file or
 * the new one and never a partial write. Writing in place truncates first: a bridge that
 * polls daemon.json and reads it at that moment gets an empty file and fails fast with
 * ATM_RUNTIME_DESCRIPTOR_INVALID.
 *
 * Windows refuses to rename over a file any process has open (EPERM), even one opened
 * with FILE_SHARE_DELETE. Readers hold daemon.json for well under a millisecond, but
 * bridges waiting for a restart read it every 100 ms and scanners open fresh files, so
 * the replace waits for the reader briefly (at most ~1.3 s in total) instead of failing
 * the daemon's start. Measured: 9 bridge-like readers made 4 of 1500 bare renames fail.
 *
 * When the publish fails, the error thrown is the one that failed it (the last rename's,
 * once the retries run out). A temporary file that could not be removed afterwards is
 * reported on that error as `suppressed`, never in its place.
 */
export function replaceFileAtomically(target: string, content: string): void {
  const temporary = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameReplacing(temporary, target);
  } catch (error) {
    // Whatever held the target may hold the temporary file too, so removing it can fail
    // as well. That must not replace the reason the publish failed: the caller gets the
    // original error, carrying the cleanup failure (and the leftover's name) with it.
    try {
      rmSync(temporary, { force: true });
    } catch (cleanupError) {
      noteSuppressed(error, cleanupError);
    }
    throw error;
  }
  rmSync(temporary, { force: true });
}

function renameReplacing(temporary: string, target: string): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(temporary, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (
        process.platform !== "win32" ||
        !HELD_OPEN_RENAME_ERRORS.has(code) ||
        attempt >= REPLACE_ATTEMPTS
      )
        throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * 2 ** (attempt - 1));
    }
  }
}

/**
 * Publish one atomic endpoint/token descriptor, then remove the obsolete second
 * token source. A failed publish leaves the legacy file untouched so an older
 * installed version can still recover; a successful retry is idempotent.
 */
function publishDaemonRuntime(runtimeDir: string, descriptor: DaemonRuntimeDescriptor): string {
  if (!runtimeDescriptor(descriptor)) throw new Error("ATM_RUNTIME_DESCRIPTOR_INVALID");
  mkdirSync(runtimeDir, { recursive: true });
  const target = join(runtimeDir, DAEMON_RUNTIME_FILENAME);
  replaceFileAtomically(target, `${JSON.stringify(descriptor)}\n`);
  rmSync(join(runtimeDir, LEGACY_TOKEN_FILENAME), { force: true });
  return target;
}

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const DAEMON_VERSION = "1.0.26";
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
  } catch {
    return false;
  }
}

export function acquireDaemonRuntime(runtimeDir: string, pid = process.pid): DaemonRuntimeLease {
  mkdirSync(runtimeDir, { recursive: true });
  const lockPath = join(runtimeDir, DAEMON_LOCK_FILENAME);
  const nonce = randomBytes(16).toString("hex");
  const content = `${JSON.stringify({ pid, nonce })}\n`;
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
    try {
      const owner = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
      if (Number.isSafeInteger(owner.pid)) ownerPid = Number(owner.pid);
    } catch {
      // Malformed locks are stale and are quarantined below.
    }
    if (ownerPid > 0 && processAlive(ownerPid)) throw new Error("ATM_RUNTIME_ALREADY_ACTIVE");
    const stalePath = `${lockPath}.stale-${pid}-${nonce}-${attempt}`;
    try {
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

/**
 * Publish one atomic endpoint/token descriptor, then remove the obsolete second
 * token source. A failed publish leaves the legacy file untouched so an older
 * installed version can still recover; a successful retry is idempotent.
 */
function publishDaemonRuntime(runtimeDir: string, descriptor: DaemonRuntimeDescriptor): string {
  if (!runtimeDescriptor(descriptor)) throw new Error("ATM_RUNTIME_DESCRIPTOR_INVALID");
  mkdirSync(runtimeDir, { recursive: true });
  const target = join(runtimeDir, DAEMON_RUNTIME_FILENAME);
  const temporary = join(
    runtimeDir,
    `.${DAEMON_RUNTIME_FILENAME}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(temporary, `${JSON.stringify(descriptor)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
  rmSync(join(runtimeDir, LEGACY_TOKEN_FILENAME), { force: true });
  return target;
}

import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

type LifecycleEvent =
  | "startup"
  | "previous.unclean"
  | "previous.session-end"
  | "ready"
  | "heartbeat"
  | "exception"
  | "bootstrap.failed"
  | "session-end"
  | "shutdown.begin"
  | "shutdown.complete"
  | "shutdown.failed"
  | "exit"
  | "renderer.gone"
  | "renderer.load-failed"
  | "child.gone";
type Detail = {
  background?: boolean;
  agentWake?: boolean;
  exitCode?: number;
  clean?: boolean;
  rss?: number;
  heapUsed?: number;
  reason?: string;
  processType?: string;
  origin?: string;
  errorName?: string;
  errorCode?: string;
  errorFingerprint?: string;
  previousRunId?: string;
  previousPid?: number;
  previousEvent?: string;
  previousAt?: string;
};
type State = { runId: string; pid: number; event: string; at: string; clean: boolean };

/** No error message/stack: those can contain database content, tokens or user paths. */
export function lifecycleError(error: unknown): Detail {
  try {
    if (!(error instanceof Error)) return { errorName: "NonError" };
    const code = "code" in error ? error.code : undefined;
    return {
      errorName: /^[A-Za-z]{1,40}$/u.test(error.name) ? error.name : "Error",
      ...(typeof code === "string" && /^[A-Z0-9_-]{1,40}$/u.test(code) ? { errorCode: code } : {}),
      errorFingerprint: createHash("sha256").update(error.message.slice(0, 4096)).digest("hex"),
    };
  } catch {
    return { errorName: "UnreadableError" };
  }
}

export function createLifecycleDiagnostics(
  dataDir: string,
  version: string,
  options: { maxLogBytes?: number; maxLogFiles?: number } = {},
) {
  const directory = join(dataDir, "logs");
  const logPath = join(directory, "lifecycle.ndjson");
  const statePath = join(directory, "lifecycle-state.json");
  const maxBytes = Math.max(4096, options.maxLogBytes ?? 256 * 1024);
  const files = Math.max(1, Math.min(5, options.maxLogFiles ?? 3));
  const runId = randomUUID();
  const tempPath = `${statePath}.${runId}.tmp`;
  let active = false;
  let finished = false;

  function record(event: LifecycleEvent, input: Detail = {}): void {
    if (!active || finished) return;
    try {
      // Explicit scalar allowlist; never spread an arbitrary diagnostics payload.
      const detail: Record<string, string | boolean | number> = {};
      for (const key of ["background", "agentWake", "clean"] as const) {
        if (typeof input[key] === "boolean") detail[key] = input[key];
      }
      for (const key of ["exitCode", "rss", "heapUsed", "previousPid"] as const) {
        if (typeof input[key] === "number" && Number.isFinite(input[key])) detail[key] = input[key];
      }
      for (const key of [
        "reason",
        "processType",
        "origin",
        "errorName",
        "errorCode",
        "errorFingerprint",
        "previousRunId",
        "previousEvent",
        "previousAt",
      ] as const) {
        const value = input[key];
        if (typeof value === "string" && /^[A-Za-z0-9_.:+-]{1,80}$/u.test(value))
          detail[key] = value;
      }
      const at = new Date().toISOString();
      const line = `${JSON.stringify({ at, event, runId, pid: process.pid, ppid: process.ppid, version: version.slice(0, 40), ...detail })}\n`;
      mkdirSync(directory, { recursive: true });
      if (existsSync(logPath) && statSync(logPath).size + Buffer.byteLength(line) > maxBytes) {
        if (files === 1) rmSync(logPath);
        else
          for (let index = files - 1; index >= 1; index--) {
            const target = join(directory, `lifecycle.${index}.ndjson`);
            const source = index === 1 ? logPath : join(directory, `lifecycle.${index - 1}.ndjson`);
            rmSync(target, { force: true });
            if (existsSync(source)) renameSync(source, target);
          }
      }
      appendFileSync(logPath, line, { encoding: "utf8", mode: 0o600 });
      const state: State = {
        runId,
        pid: process.pid,
        event,
        at,
        clean: event === "exit" && input.clean === true,
      };
      writeFileSync(tempPath, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
      renameSync(tempPath, statePath);
    } catch {
      // Full disk / access failures must not become a new reason for ATM to exit.
    } finally {
      try {
        rmSync(tempPath, { force: true });
      } catch {
        /* best effort */
      }
    }
  }

  function start(input: Pick<Detail, "background" | "agentWake">): void {
    if (active) return;
    active = true;
    try {
      if (statSync(statePath).size <= 4096) {
        const previous = JSON.parse(readFileSync(statePath, "utf8")) as Partial<State> | null;
        if (previous && previous.clean === false && typeof previous.runId === "string") {
          // Windows ends the session before the quit chain can finish, so the last
          // marker a shutdown leaves is "session-end", not "exit". That is an explained
          // termination; calling it unclean once sent an investigation after a killer
          // that never existed. Every later record overwrites the marker (the heartbeat
          // does so within a minute), so a kill after a cancelled shutdown still counts.
          record(previous.event === "session-end" ? "previous.session-end" : "previous.unclean", {
            previousRunId: previous.runId,
            ...(typeof previous.pid === "number" ? { previousPid: previous.pid } : {}),
            ...(typeof previous.event === "string" ? { previousEvent: previous.event } : {}),
            ...(typeof previous.at === "string" ? { previousAt: previous.at } : {}),
          });
        }
      }
    } catch {
      /* first run or unreadable marker: no historical conclusion */
    }
    record("startup", input);
  }

  function finish(exitCode: number, clean: boolean): void {
    if (!active || finished) return;
    record("exit", { exitCode, clean });
    finished = true;
  }
  return { start, record, finish };
}

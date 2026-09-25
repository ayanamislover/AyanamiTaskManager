import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createLifecycleDiagnostics, lifecycleError } from "../src/lifecycle-diagnostics.js";

const directories: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "atm-lifecycle-"));
  directories.push(dir);
  return dir;
}
function lines(dir: string) {
  return readFileSync(join(dir, "logs", "lifecycle.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("bounded desktop lifecycle diagnostics", () => {
  it("monitoring preserves Node fatal exceptions and rejection exit behavior", () => {
    for (const trigger of [
      "throw new Error('private-message')",
      "Promise.reject(new Error('private-message'))",
    ]) {
      const dir = fixture();
      const source = pathToFileURL(
        join(process.cwd(), "apps/desktop/src/lifecycle-diagnostics.ts"),
      ).href;
      const child = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `
        import {createLifecycleDiagnostics,lifecycleError} from ${JSON.stringify(source)};
        const log=createLifecycleDiagnostics(${JSON.stringify(dir)},'test');
        log.start({background:true,agentWake:false});
        process.on('uncaughtExceptionMonitor',(error,origin)=>log.record('exception',{...lifecycleError(error),origin}));
        process.on('exit',code=>log.finish(code,false));
        setImmediate(()=>{${trigger};});
      `,
        ],
        { timeout: 10_000, windowsHide: true, encoding: "utf8" },
      );
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(1);
      expect(lines(dir).some((line) => line.event === "exception")).toBe(true);
      expect(lines(dir).at(-1)).toMatchObject({ event: "exit", exitCode: 1, clean: false });
      expect(JSON.stringify(lines(dir))).not.toContain("private-message");
    }
  });

  it("desktop hooks monitor faults without swallowing exceptions or rejections", () => {
    const source = readFileSync(join(process.cwd(), "apps/desktop/src/main.ts"), "utf8");
    expect(source).toContain('process.on("uncaughtExceptionMonitor"');
    expect(source).not.toMatch(/process\.on\("(?:uncaughtException|unhandledRejection)"/u);
    expect(source.indexOf("lifecycle.start(")).toBeGreaterThan(
      source.indexOf("app.requestSingleInstanceLock()"),
    );
    for (const hook of ['"child-process-gone"', '"render-process-gone"', '"did-fail-load"'])
      expect(source).toContain(hook);
  });

  it("only activates for the primary desktop and records clean shutdown once", () => {
    const dir = fixture();
    const log = createLifecycleDiagnostics(dir, "9.9.9");
    log.record("shutdown.begin");
    expect(readdirSync(dir)).toEqual([]);
    log.start({ background: true, agentWake: false });
    log.record("shutdown.begin");
    log.finish(0, true);
    log.finish(0, true);
    expect(lines(dir).map((line) => line.event)).toEqual(["startup", "shutdown.begin", "exit"]);
    const next = createLifecycleDiagnostics(dir, "9.9.9");
    next.start({ background: false, agentWake: false });
    expect(lines(dir).some((line) => line.event === "previous.unclean")).toBe(false);
  });

  it("reports unfinished previous run without asserting a crash cause", () => {
    const dir = fixture();
    const first = createLifecycleDiagnostics(dir, "9.9.9");
    first.start({ background: true, agentWake: true });
    first.record("heartbeat", { rss: 123456 });
    const next = createLifecycleDiagnostics(dir, "9.9.9");
    next.start({ background: true, agentWake: false });
    const record = lines(dir).find((line) => line.event === "previous.unclean");
    expect(record.previousEvent).toBe("heartbeat");
    expect(record.previousRunId).toBe(lines(dir)[0].runId);
    expect(record).not.toHaveProperty("cause");
  });

  /**
   * Observed 2026-09-23 18:15 local: the user powered the machine off normally, the last
   * heartbeat landed 28s earlier, and the next start called that previous.unclean — which
   * reads as "something killed ATM" and misdirected the disappearance investigation.
   */
  it("treats a Windows session end as an explained termination, not an unclean one", () => {
    const dir = fixture();
    const first = createLifecycleDiagnostics(dir, "9.9.9");
    first.start({ background: true, agentWake: false });
    first.record("heartbeat", { rss: 123456 });
    first.record("session-end");
    createLifecycleDiagnostics(dir, "9.9.9").start({ background: false, agentWake: false });
    const events = lines(dir).map((line) => line.event);
    expect(events).not.toContain("previous.unclean");
    const record = lines(dir).find((line) => line.event === "previous.session-end");
    // The evidence still has to be there, only the verdict changes.
    expect(record.previousEvent).toBe("session-end");
    expect(record.previousRunId).toBe(lines(dir)[0].runId);
    expect(record.previousPid).toBe(process.pid);
    expect(typeof record.previousAt).toBe("string");
  });

  it("stops excusing the run once anything happens after the session-end marker", () => {
    const dir = fixture();
    const first = createLifecycleDiagnostics(dir, "9.9.9");
    first.start({ background: true, agentWake: false });
    first.record("session-end");
    // Shutdown was cancelled, the process kept running — and was then killed for real.
    first.record("heartbeat", { rss: 1 });
    createLifecycleDiagnostics(dir, "9.9.9").start({ background: false, agentWake: false });
    const events = lines(dir).map((line) => line.event);
    expect(events).toContain("previous.unclean");
    expect(events).not.toContain("previous.session-end");
  });

  it("the desktop subscribes every window to session-end and writes it synchronously", () => {
    const source = readFileSync(join(process.cwd(), "apps/desktop/src/main.ts"), "utf8");
    // Electron puts session-end on the window, so the subscription has to ride on window
    // creation — app.on("session-end") silently never fires. And because Windows kills the
    // process right after the notification, anything deferred to a microtask, a timer or an
    // await would never reach the disk: pin the whole handler body, not just its presence.
    expect(source).toMatch(
      /app\.on\("browser-window-created", \(_event, window\) => \{\s*window\.on\("session-end", \(\) => lifecycle\.record\("session-end"\)\);\s*\}\);/u,
    );
  });

  it("session-end is a window event in this Electron, not an app event", () => {
    // If a future Electron moves it onto app, the wiring above stops firing without any
    // type error, so the assumption it rests on is pinned here rather than in a comment.
    const typings = readFileSync(
      join(process.cwd(), "node_modules/electron/electron.d.ts"),
      "utf8",
    );
    const appInterface = typings.slice(
      typings.indexOf("interface App extends"),
      typings.indexOf("class BaseWindow extends"),
    );
    expect(appInterface).toContain("'browser-window-created'");
    expect(appInterface).not.toContain("'session-end'");
    expect(typings.slice(typings.indexOf("class BaseWindow extends"))).toContain(
      "on(event: 'session-end'",
    );
  });

  it("bounds rotation including a single retained file", () => {
    for (const files of [1, 3]) {
      const dir = fixture();
      const log = createLifecycleDiagnostics(dir, "9.9.9", {
        maxLogBytes: 4096,
        maxLogFiles: files,
      });
      log.start({ background: true, agentWake: false });
      for (let i = 0; i < 80; i++) log.record("heartbeat", { rss: i });
      const logs = readdirSync(join(dir, "logs")).filter((name) => name.endsWith(".ndjson"));
      expect(logs).toHaveLength(files);
      for (const name of logs)
        expect(statSync(join(dir, "logs", name)).size).toBeLessThanOrEqual(4096);
    }
  });

  it("diagnostics failure never interrupts the desktop", () => {
    const dir = fixture();
    writeFileSync(join(dir, "logs"), "not a directory");
    const log = createLifecycleDiagnostics(dir, "9.9.9");
    expect(() => {
      log.start({ background: false, agentWake: false });
      log.record("ready");
      log.finish(0, true);
    }).not.toThrow();
  });

  it("does not serialize error objects, messages, URLs, arguments or token values", () => {
    const dir = fixture();
    const error = Object.assign(
      new Error("secret-token-value http://127.0.0.1/?token=secret-token-value"),
      { code: "EPIPE" },
    );
    const detail = lifecycleError(error);
    expect(detail.errorCode).toBe("EPIPE");
    expect(detail.errorName).toBe("Error");
    const log = createLifecycleDiagnostics(dir, "9.9.9");
    log.start({ background: false, agentWake: false });
    log.record("exception", { ...detail, token: "secret-token-value" } as never);
    const output = JSON.stringify(lines(dir));
    expect(output).not.toContain("secret-token-value");
    expect(output).not.toContain("http://");
    expect(output).not.toContain("lifecycle-diagnostics.test.ts");
    expect(
      lifecycleError({
        get message() {
          throw new Error("bad getter");
        },
      }),
    ).toEqual({ errorName: "NonError" });
  });

  it("ignores oversized or malformed prior markers", () => {
    const dir = fixture();
    const log = createLifecycleDiagnostics(dir, "9.9.9");
    log.start({ background: false, agentWake: false });
    writeFileSync(join(dir, "logs", "lifecycle-state.json"), "x".repeat(4097));
    expect(() =>
      createLifecycleDiagnostics(dir, "9.9.9").start({ background: false, agentWake: false }),
    ).not.toThrow();
    expect(lines(dir).filter((line) => line.event === "previous.unclean")).toHaveLength(0);
  });
});

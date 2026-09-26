import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceFileAtomically } from "../src/runtime-discovery.js";

/**
 * Whatever keeps the target from being replaced (a reader, a scanner) can keep the
 * temporary file from being removed as well. The publish then fails twice over, and the
 * error the daemon reports must be the one that failed the publish: the last rename's.
 * These cases make renameSync and the temporary file's rmSync refuse the way Windows does.
 */
const { faults } = vi.hoisted(() => ({
  faults: { rename: "", cleanup: "", renameCalls: 0 },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const refuse = (code: string, syscall: string, path: string) =>
    Object.assign(new Error(`${code}: ${syscall} '${path}'`), { code, syscall, path });
  const renameSync: typeof actual.renameSync = (from, to) => {
    faults.renameCalls += 1;
    if (faults.rename) throw refuse(faults.rename, "rename", String(from));
    return actual.renameSync(from, to);
  };
  const rmSync: typeof actual.rmSync = (path, options) => {
    if (faults.cleanup && String(path).endsWith(".tmp"))
      throw refuse(faults.cleanup, "rm", String(path));
    return actual.rmSync(path, options);
  };
  return { ...actual, renameSync, rmSync, default: { ...actual, renameSync, rmSync } };
});

const temporary: string[] = [];

afterEach(() => {
  Object.assign(faults, { rename: "", cleanup: "", renameCalls: 0 });
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runtimeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "atm-runtime-replace-fail-"));
  temporary.push(directory);
  return directory;
}

function replaceError(target: string): unknown {
  try {
    replaceFileAtomically(target, '{"generation":1}\n');
  } catch (error) {
    return error;
  }
  throw new Error("replaceFileAtomically did not fail");
}

describe("replaceFileAtomically when the publish fails", () => {
  it("throws the rename error, not the cleanup error that followed it", () => {
    const directory = runtimeDirectory();
    faults.rename = "EPERM";
    faults.cleanup = "EACCES";

    const error = replaceError(join(directory, "daemon.json"));

    // Every retry is spent on win32; elsewhere EPERM is not retried at all.
    expect(faults.renameCalls).toBe(process.platform === "win32" ? 8 : 1);
    expect(error).toMatchObject({ code: "EPERM", syscall: "rename" });
    // The leftover is not hidden either: the cleanup failure rides on the original error.
    expect((error as { suppressed?: unknown }).suppressed).toEqual([
      expect.objectContaining({ code: "EACCES", syscall: "rm" }),
    ]);
    expect(readdirSync(directory)).toHaveLength(1);
  });

  it("removes the temporary file and reports the rename error alone when cleanup works", () => {
    const directory = runtimeDirectory();
    faults.rename = "EPERM";

    const error = replaceError(join(directory, "daemon.json"));

    expect(error).toMatchObject({ code: "EPERM", syscall: "rename" });
    expect(error).not.toHaveProperty("suppressed");
    expect(readdirSync(directory)).toEqual([]);
  });
});

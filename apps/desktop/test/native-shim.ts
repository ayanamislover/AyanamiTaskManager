import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const SHIM_CRATE = join(process.cwd(), "apps", "desktop", "native", "mcp-shim");
const RELEASE = join(SHIM_CRATE, "target", "release");
export const SHIM_EXE = join(RELEASE, "atm-mcp.exe");
export const WAKE_RECORDER_EXE = join(RELEASE, "examples", "wake-recorder.exe");

let built = false;

/**
 * Builds the shim and its wake-path test double from the working tree.
 *
 * Deliberately a hard failure, never a skip: a contract suite that quietly skips the
 * native half when cargo is missing would stay green while testing only the old bridge.
 * Cargo is incremental, so this is about a second once the tree is built.
 */
export function ensureNativeShim(): string {
  if (built) return SHIM_EXE;
  const result = spawnSync("cargo", ["build", "--release", "--locked", "--bins", "--examples"], {
    cwd: SHIM_CRATE,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `NATIVE_SHIM_BUILD_FAILED: cargo build in ${SHIM_CRATE} exited ${result.status}\n` +
        `${result.error?.message ?? ""}${result.stderr ?? ""}`,
    );
  for (const artifact of [SHIM_EXE, WAKE_RECORDER_EXE])
    if (!existsSync(artifact)) throw new Error(`NATIVE_SHIM_ARTIFACT_MISSING: ${artifact}`);
  built = true;
  return SHIM_EXE;
}

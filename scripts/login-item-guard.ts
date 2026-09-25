import { execFileSync } from "node:child_process";

/**
 * The packaged smoke asserts that the "start at login" switch writes and restores its
 * registry value. Electron has no option for the value name: it always writes the
 * app's AppUserModelId under HKCU Run, so the smoke's isolated data root and the real
 * installation share one value. A smoke run therefore overwrites the user's real entry
 * and, when it restores "off", deletes it — silently disabling autostart for good.
 *
 * Fix the blast radius where the environment is owned: snapshot the key around the run
 * and put back anything the smoke touched. Only entries that name this application are
 * managed, so an unrelated app writing its own Run value meanwhile is left alone.
 */
export type RunEntries = Record<string, string>;
export type RunRestoreStep =
  | { action: "set"; name: string; data: string }
  | { action: "delete"; name: string };

const APPLICATION = "ayanamitaskmanager";
const mentionsApplication = (name: string, data: string) =>
  `${name} ${data}`.toLowerCase().includes(APPLICATION);

/** Steps that turn `after` back into `before` for this application's entries only. */
export function loginItemRestorePlan(before: RunEntries, after: RunEntries): RunRestoreStep[] {
  const steps: RunRestoreStep[] = [];
  for (const [name, data] of Object.entries(before)) {
    if (!mentionsApplication(name, data)) continue;
    if (after[name] !== data) steps.push({ action: "set", name, data });
  }
  for (const [name, data] of Object.entries(after)) {
    if (name in before || !mentionsApplication(name, data)) continue;
    steps.push({ action: "delete", name });
  }
  return steps;
}

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

export function readRunEntries(): RunEntries {
  if (process.platform !== "win32") return {};
  let output: string;
  try {
    output = execFileSync("reg.exe", ["query", RUN_KEY], { encoding: "utf8", windowsHide: true });
  } catch {
    return {};
  }
  const entries: RunEntries = {};
  for (const line of output.split(/\r?\n/u)) {
    // "    <name>    REG_SZ    <data>" — data itself may contain runs of spaces.
    const match = /^ {4}(.+?) {4}(REG_[A-Z_]+) {4}(.*)$/u.exec(line);
    if (match) entries[match[1]!] = match[3]!;
  }
  return entries;
}

export function applyRunRestore(steps: readonly RunRestoreStep[]): void {
  for (const step of steps) {
    if (step.action === "set")
      execFileSync(
        "reg.exe",
        ["add", RUN_KEY, "/v", step.name, "/t", "REG_SZ", "/d", step.data, "/f"],
        {
          windowsHide: true,
        },
      );
    else execFileSync("reg.exe", ["delete", RUN_KEY, "/v", step.name, "/f"], { windowsHide: true });
  }
}

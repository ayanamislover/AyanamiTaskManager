import { execFileSync } from "node:child_process";

/**
 * The "start at login" switch writes the AppUserModelId value under HKCU Run, and that
 * name is shared with the user's real installation (native setup kept the Squirrel-era
 * name). A smoke that flips the switch therefore overwrites the real entry, and switching
 * it off deletes it — silently disabling autostart for good.
 *
 * Restore only what this run itself did: an entry is put back when its current value
 * still names one of this run's own executables (this run wrote it), or when it is gone
 * and this run deleted that very name (`deleted`, recorded at the step that deletes it).
 * A value the user changed or removed in the meantime — the real app's own settings,
 * another tool — is left alone. Entries that do not name this application are never
 * touched. The value type is kept on restore.
 */
export type RunEntry = { type: string; data: string };
export type RunSnapshot = Record<string, RunEntry>;
export type RunRestoreStep =
  | { action: "set"; name: string; type: string; data: string }
  | { action: "delete"; name: string };
export type RunOwnership = {
  /** Executables this run launched; a value naming one of them was written by this run. */
  executables: readonly string[];
  /**
   * Names this run removed itself: recorded right at the step that removes them (switching
   * autostart off, uninstalling), never assumed for the whole run. A name not listed that is
   * gone was removed by someone else.
   */
  deleted: readonly string[];
};

const APPLICATION = "ayanamitaskmanager";
const mentionsApplication = (name: string, data: string) =>
  `${name} ${data}`.toLowerCase().includes(APPLICATION);

/** Steps that undo this run's own changes to this application's entries. */
export function loginItemRestorePlan(
  before: RunSnapshot,
  after: RunSnapshot,
  owned: RunOwnership,
): RunRestoreStep[] {
  const ours = (data: string) =>
    owned.executables.some((executable) => data.toLowerCase().includes(executable.toLowerCase()));
  const steps: RunRestoreStep[] = [];
  for (const [name, entry] of Object.entries(before)) {
    if (!mentionsApplication(name, entry.data)) continue;
    const now = after[name];
    if (now?.data === entry.data && now.type === entry.type) continue;
    if (now ? ours(now.data) : owned.deleted.includes(name))
      steps.push({ action: "set", name, type: entry.type, data: entry.data });
  }
  for (const [name, entry] of Object.entries(after)) {
    if (name in before || !mentionsApplication(name, entry.data)) continue;
    if (ours(entry.data)) steps.push({ action: "delete", name });
  }
  return steps;
}

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

export function parseRunQuery(output: string): RunSnapshot {
  const entries: RunSnapshot = {};
  for (const line of output.split(/\r?\n/u)) {
    // "    <name>    REG_SZ    <data>" — data itself may contain runs of spaces.
    const match = /^ {4}(.+?) {4}(REG_[A-Z_]+) {4}(.*)$/u.exec(line);
    if (match) entries[match[1]!] = { type: match[2]!, data: match[3]! };
  }
  return entries;
}

/**
 * The Run key as it is now. A failed query throws: an empty snapshot would make the
 * restore believe every entry was added by this run, or that none existed before.
 */
export function readRunSnapshot(): RunSnapshot {
  if (process.platform !== "win32") return {};
  return parseRunQuery(
    execFileSync("reg.exe", ["query", RUN_KEY], { encoding: "utf8", windowsHide: true }),
  );
}

/** Values only, for assertions. */
export function readRunEntries(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(readRunSnapshot()).map(([name, entry]) => [name, entry.data]),
  );
}

export function applyRunRestore(steps: readonly RunRestoreStep[]): void {
  for (const step of steps) {
    if (step.action === "set")
      execFileSync(
        "reg.exe",
        ["add", RUN_KEY, "/v", step.name, "/t", step.type, "/d", step.data, "/f"],
        { windowsHide: true },
      );
    else execFileSync("reg.exe", ["delete", RUN_KEY, "/v", step.name, "/f"], { windowsHide: true });
  }
}

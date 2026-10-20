import { type RegistryValue, registryDelete, registrySet, registryValues } from "./windows-text.js";

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
 * touched. The restore writes the value type and bytes back as they were (W8 gate peer r18 P2-01:
 * the text form of a REG_MULTI_SZ is not one-to-one). Value names compare case-insensitively, as the
 * registry does: "COM.SQUIRREL..." and "com.squirrel..." are the same value.
 */
export type RunEntry = RegistryValue;
export type RunSnapshot = Record<string, RunEntry>;
export type RunRestoreStep =
  | { action: "set"; name: string; value: RunEntry }
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

const sameName = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

/** The value with this name, compared as the registry compares names (case-insensitively). */
export function findRunEntry(snapshot: RunSnapshot, name: string): RunEntry | undefined {
  const found = Object.keys(snapshot).find((candidate) => sameName(candidate, name));
  return found === undefined ? undefined : snapshot[found];
}

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
    const now = findRunEntry(after, name);
    if (now?.code === entry.code && now.raw === entry.raw) continue;
    if (now ? ours(now.data) : owned.deleted.some((deleted) => sameName(deleted, name)))
      steps.push({ action: "set", name, value: entry });
  }
  for (const [name, entry] of Object.entries(after)) {
    if (findRunEntry(before, name) || !mentionsApplication(name, entry.data)) continue;
    if (ours(entry.data)) steps.push({ action: "delete", name });
  }
  return steps;
}

/** 自启登记的值名：与 setup（register.rs RUN_VALUE）及真实安装共用。 */
export const RUN_VALUE = "com.squirrel.AyanamiTaskManagerDesktop.AyanamiTaskManager";

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

/**
 * The Run key as it is now, read through advapi32 (see windows-text.ts: reg.exe prints in the system
 * code page, so a value naming a path outside it would not compare). A failed read throws: an empty
 * snapshot would make the restore believe every entry was added by this run, or that none existed
 * before. A missing key has no entries.
 */
export function readRunSnapshot(): RunSnapshot {
  if (process.platform !== "win32") return {};
  return registryValues(RUN_KEY) ?? {};
}

/** Values only, for assertions. */
export function readRunEntries(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(readRunSnapshot()).map(([name, entry]) => [name, entry.data]),
  );
}

/** Writes the plan back through windows-text.ts (advapi32): type code and bytes as snapshotted. */
export function applyRunRestore(steps: readonly RunRestoreStep[]): void {
  for (const step of steps) {
    if (step.action === "set") registrySet(RUN_KEY, step.name, step.value);
    else registryDelete(RUN_KEY, step.name);
  }
}

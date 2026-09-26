import { noteSuppressed } from "@ayanami-task/errors";

/**
 * Run every close stage even when an earlier one throws, then rethrow the first failure
 * with the later ones attached to it as `suppressed`. A handle left open because some
 * other handle failed to close is a leak nobody can reach any more.
 */
export function closeAllStages(stages: Iterable<() => void>): void {
  let first: { error: unknown } | undefined;
  for (const stage of stages) {
    try {
      stage();
    } catch (error) {
      if (first) noteSuppressed(first.error, error);
      else first = { error };
    }
  }
  if (first) throw first.error;
}

import { asAtmError, type AtmError } from "@ayanami-task/errors";

export type MutationErrorContext = {
  taskKey?: string;
  checklistId?: string;
  expectedVersion?: number;
  expectedVersions?: Record<string, number>;
};

export async function withMutationErrorDetails<T>(
  projectCode: string,
  context: MutationErrorContext,
  enrichError: (
    error: unknown,
    context: MutationErrorContext & { projectCode: string },
  ) => Promise<AtmError>,
  action: () => T | Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const base = asAtmError(error);
    let enriched = base;
    try {
      enriched = await enrichError(base, { projectCode, ...context });
    } catch {
      // Error reporting must never hide the authoritative mutation failure.
    }
    throw enriched;
  }
}

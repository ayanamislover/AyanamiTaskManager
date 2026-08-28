import type { MutationActorResolution, ProjectionReceipt } from "@ayanami-task/storage-sqlite";

export function mutationAck<T extends Record<string, unknown>>(
  result: T,
  opId: string,
  resolution: MutationActorResolution,
  projection: ProjectionReceipt,
) {
  return {
    ...result,
    opId,
    projection,
    ...(resolution.disposition === "REBOUND"
      ? {
          sessionRebound: true,
          session: resolution.actor.sessionId,
          newSession: resolution.actor.sessionId,
        }
      : {}),
  };
}

export function projectMutationReceipt<T extends Record<string, unknown>>(
  result: T,
  projection: ProjectionReceipt,
): T & { projection: ProjectionReceipt } {
  return { ...result, projection };
}

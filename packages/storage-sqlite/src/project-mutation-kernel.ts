import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { AtmError } from "@ayanami-task/errors";
import { createUlid, nowIso } from "@ayanami-task/protocol";

export type MutationActor = {
  type: "AGENT" | "USER" | "SYSTEM";
  id: string;
  sessionId: string | null;
};

export type MutationInput<T> = {
  actor: MutationActor;
  opId: string;
  operation: string;
  request: unknown;
  compatibleRequests?: readonly unknown[];
  validateCompatibleReplay?: () => void;
  action: () => T;
  idempotencyKey?: string;
  immediate?: boolean;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function requestFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)) ?? "null")
    .digest("hex");
}

/**
 * Owns the Project DB mutation boundary. Command modules may execute inside the action closure,
 * but transaction, active operation attribution, event/outbox append, and idempotency response
 * persistence remain centralized here.
 */
export class ProjectMutationKernel {
  readonly #sqlite: Database.Database;
  #activeOperationId: string | null = null;

  constructor(sqlite: Database.Database) {
    this.#sqlite = sqlite;
  }

  transaction<T>(action: () => T, immediate = false): T {
    const transaction = this.#sqlite.transaction(action);
    return immediate ? transaction.immediate() : transaction();
  }

  nextNumber(name: string): number {
    const row = this.#sqlite
      .prepare(
        "UPDATE counters SET next_value = next_value + 1 WHERE name = ? RETURNING next_value - 1 AS value",
      )
      .get(name) as { value: number } | undefined;
    if (!row)
      throw new AtmError("COUNTER_NOT_FOUND", {
        message: `计数器不存在：${name}`,
        details: { reference: name },
      });
    return row.value;
  }

  appendEvent(
    type: string,
    actor: MutationActor,
    aggregateType: string,
    aggregateId: string,
    payload: unknown,
    correlationId: string | null = null,
  ): number {
    const at = nowIso();
    const sequenceRow = this.#sqlite
      .prepare(
        `UPDATE project_meta SET current_sequence = current_sequence + 1, updated_at = ?
         WHERE singleton = 1 RETURNING current_sequence`,
      )
      .get(at) as { current_sequence: number };
    const eventId = createUlid();
    this.#sqlite
      .prepare(
        `INSERT INTO events(
           id, sequence, type, actor_type, actor_id, session_id, aggregate_type, aggregate_id,
           causation_id, correlation_id, payload_json, created_at, op_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        sequenceRow.current_sequence,
        type,
        actor.type,
        actor.id,
        actor.sessionId,
        aggregateType,
        aggregateId,
        correlationId,
        JSON.stringify(payload),
        at,
        this.#activeOperationId,
      );
    this.#sqlite
      .prepare(
        `INSERT INTO outbox(id, project_sequence, type, payload_json, created_at)
         VALUES (?, ?, 'registry.project_changed', ?, ?)`,
      )
      .run(
        createUlid(),
        sequenceRow.current_sequence,
        JSON.stringify({ eventId, type, aggregateType, aggregateId }),
        at,
      );
    return sequenceRow.current_sequence;
  }

  mutate<T>(input: MutationInput<T>): T {
    return this.mutateWithReplay(input).value;
  }

  mutateWithReplay<T>(input: MutationInput<T>): { value: T; replayed: boolean } {
    const key = input.idempotencyKey ?? `${input.actor.sessionId ?? input.actor.id}:${input.opId}`;
    const fingerprint = requestFingerprint(input.request);
    const compatibleFingerprints = new Set(
      (input.compatibleRequests ?? []).map((request) => requestFingerprint(request)),
    );
    return this.transaction(() => {
      const cached = this.#sqlite
        .prepare("SELECT * FROM idempotency_keys WHERE key = ?")
        .get(key) as
        | { operation: string; request_fingerprint: string; response_json: string }
        | undefined;
      if (cached) {
        if (cached.operation !== input.operation) {
          throw new AtmError("IDEMPOTENCY_CONFLICT", {
            message: `幂等键冲突：${key}`,
            details: { key },
          });
        }
        if (cached.request_fingerprint !== fingerprint) {
          if (!compatibleFingerprints.has(cached.request_fingerprint)) {
            throw new AtmError("IDEMPOTENCY_CONFLICT", {
              message: `幂等键冲突：${key}`,
              details: { key },
            });
          }
          if (!input.validateCompatibleReplay) {
            throw new AtmError("IDEMPOTENCY_CONFLICT", {
              message: `幂等键冲突：${key}`,
              details: { key },
            });
          }
          input.validateCompatibleReplay();
        }
        return { value: JSON.parse(cached.response_json) as T, replayed: true };
      }
      const previousOperationId = this.#activeOperationId;
      this.#activeOperationId = input.opId;
      let result: T;
      try {
        result = input.action();
      } finally {
        this.#activeOperationId = previousOperationId;
      }
      this.#sqlite
        .prepare(
          `INSERT INTO idempotency_keys(
             key, operation, request_fingerprint, response_json, created_at, op_id, actor_session_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          key,
          input.operation,
          fingerprint,
          JSON.stringify(result),
          nowIso(),
          input.opId,
          input.actor.sessionId,
        );
      return { value: result, replayed: false };
    }, input.immediate);
  }
}

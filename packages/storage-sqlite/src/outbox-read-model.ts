import type Database from "better-sqlite3";
import { readJson } from "./read-model-mappers.js";

export type PendingOutboxEntry = {
  id: string;
  project_sequence: number;
  eventId: string | null;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  actor: string;
  eventPayload: Record<string, unknown>;
  eventSequence: number;
  eventAt: string | null;
};

export class OutboxReadModel {
  constructor(private readonly sqlite: Database.Database) {}

  pendingOutbox(limit = 500): PendingOutboxEntry[] {
    const rows = this.sqlite
      .prepare(
        `WITH pending AS (
           SELECT id, project_sequence, payload_json
           FROM outbox
           WHERE delivered_at IS NULL
           ORDER BY project_sequence, id
           LIMIT ?
         ), decoded AS (
           SELECT pending.*,
                  CASE WHEN json_valid(payload_json)
                    THEN CASE WHEN json_type(payload_json, '$.eventId') = 'text'
                      THEN json_extract(payload_json, '$.eventId')
                      ELSE NULL END
                    ELSE NULL END AS decoded_event_id
           FROM pending
         )
         SELECT decoded.id, decoded.project_sequence, decoded.payload_json,
                event.sequence AS event_sequence, event.type AS event_type,
                event.aggregate_type AS event_aggregate_type,
                event.aggregate_id AS event_aggregate_id,
                event.actor_type AS event_actor_type, event.actor_id AS event_actor_id,
                event.payload_json AS event_payload_json, event.created_at AS event_created_at
         FROM decoded
         LEFT JOIN events event ON event.id = decoded.decoded_event_id
         ORDER BY decoded.project_sequence, decoded.id`,
      )
      .all(limit) as any[];
    return rows.map((row) => {
      const payload = readJson<{
        eventId?: unknown;
        type?: string;
        aggregateType?: string;
        aggregateId?: string;
      }>(row.payload_json, {});
      const eventId = typeof payload.eventId === "string" ? payload.eventId : null;
      const hasEvent = row.event_sequence !== null && row.event_sequence !== undefined;
      return {
        id: String(row.id),
        project_sequence: Number(row.project_sequence),
        eventId,
        eventType: hasEvent ? String(row.event_type) : (payload.type ?? ""),
        aggregateType: hasEvent ? String(row.event_aggregate_type) : (payload.aggregateType ?? ""),
        aggregateId: hasEvent ? String(row.event_aggregate_id) : (payload.aggregateId ?? ""),
        actor: hasEvent ? String(row.event_actor_id ?? row.event_actor_type ?? "SYSTEM") : "SYSTEM",
        eventPayload: hasEvent ? readJson<Record<string, unknown>>(row.event_payload_json, {}) : {},
        eventSequence: hasEvent ? Number(row.event_sequence) : Number(row.project_sequence),
        eventAt: hasEvent ? (row.event_created_at ?? null) : null,
      };
    });
  }
}

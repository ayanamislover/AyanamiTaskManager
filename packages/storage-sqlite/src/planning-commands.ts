import type Database from "better-sqlite3";
import { AtmError } from "@ayanami-task/errors";
import { createUlid, nowIso } from "@ayanami-task/protocol";
import { ProjectMutationKernel, type MutationActor } from "./project-mutation-kernel.js";

export class PlanningCommands {
  readonly #sqlite: Database.Database;
  readonly #mutation: ProjectMutationKernel;

  constructor(sqlite: Database.Database, mutation: ProjectMutationKernel) {
    this.#sqlite = sqlite;
    this.#mutation = mutation;
  }

  getActiveObjective(): any | null {
    return (
      this.#sqlite
        .prepare(
          "SELECT * FROM objectives WHERE status = 'ACTIVE' ORDER BY updated_at DESC LIMIT 1",
        )
        .get() ?? null
    );
  }

  getActiveMilestone(objectiveId?: string): any | null {
    return (
      this.#sqlite
        .prepare(
          `SELECT * FROM milestones WHERE status = 'ACTIVE'
           AND (? IS NULL OR objective_id = ?) ORDER BY sort_key LIMIT 1`,
        )
        .get(objectiveId ?? null, objectiveId ?? null) ?? null
    );
  }

  listObjectives(): any[] {
    return this.#sqlite.prepare("SELECT * FROM objectives ORDER BY created_at").all() as any[];
  }

  listMilestones(objectiveId?: string): any[] {
    return this.#sqlite
      .prepare(
        `SELECT * FROM milestones WHERE (? IS NULL OR objective_id = ?)
         ORDER BY sort_key, created_at`,
      )
      .all(objectiveId ?? null, objectiveId ?? null) as any[];
  }

  createObjective(
    actor: MutationActor,
    input: { title: string; description: string; definitionOfDone: string[] },
    opId = `objective-${createUlid()}`,
  ): any {
    return this.#mutation.mutate({
      actor,
      opId,
      operation: "objective.create",
      request: input,
      action: () => {
        const now = nowIso();
        this.#sqlite
          .prepare(
            "UPDATE objectives SET status = 'PLANNED', version = version + 1, updated_at = ? WHERE status = 'ACTIVE'",
          )
          .run(now);
        const id = createUlid();
        const localNo = this.#mutation.nextNumber("objective");
        this.#sqlite
          .prepare(
            `INSERT INTO objectives(
               id, local_no, title, description, definition_of_done_json, status, weight,
               version, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', 1, 0, ?, ?)`,
          )
          .run(
            id,
            localNo,
            input.title,
            input.description,
            JSON.stringify(input.definitionOfDone),
            now,
            now,
          );
        const sequence = this.#mutation.appendEvent("objective.created", actor, "OBJECTIVE", id, {
          localNo,
          title: input.title,
        });
        return { id, localNo, title: input.title, status: "ACTIVE", version: 0, sequence };
      },
    });
  }

  createMilestone(
    actor: MutationActor,
    input: { objectiveId: string; title: string; description?: string; targetDate?: string | null },
    opId = `milestone-${createUlid()}`,
  ): any {
    return this.#mutation.mutate({
      actor,
      opId,
      operation: "milestone.create",
      request: input,
      action: () => {
        const objective = this.#sqlite
          .prepare("SELECT id FROM objectives WHERE id = ?")
          .get(input.objectiveId);
        if (!objective)
          throw new AtmError("OBJECTIVE_NOT_FOUND", {
            message: `目标不存在：${input.objectiveId}`,
            details: { entity: "OBJECTIVE", reference: input.objectiveId },
          });
        const now = nowIso();
        const id = createUlid();
        const localNo = this.#mutation.nextNumber("milestone");
        const sortKey = (
          this.#sqlite
            .prepare("SELECT COALESCE(MAX(sort_key), 0) + 1000 AS value FROM milestones")
            .get() as { value: number }
        ).value;
        this.#sqlite
          .prepare(
            `INSERT INTO milestones(
               id, local_no, objective_id, title, description, target_date, status, weight,
               sort_key, version, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', 1, ?, 0, ?, ?)`,
          )
          .run(
            id,
            localNo,
            input.objectiveId,
            input.title,
            input.description ?? "",
            input.targetDate ?? null,
            sortKey,
            now,
            now,
          );
        const sequence = this.#mutation.appendEvent("milestone.created", actor, "MILESTONE", id, {
          localNo,
          title: input.title,
        });
        return { id, localNo, title: input.title, status: "ACTIVE", version: 0, sequence };
      },
    });
  }
}

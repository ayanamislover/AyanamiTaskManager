import type Database from "better-sqlite3";
import { AtmError } from "@ayanami-task/errors";
import { EvidenceInputSchema } from "@ayanami-task/protocol";
import type { RecordReadModel } from "./record-read-model.js";
import type { TaskReadModel } from "./task-read-model.js";

export class EvidenceNormalizer {
  readonly #projectCode: string;
  readonly #recordReads: RecordReadModel;
  readonly #taskReads: TaskReadModel;

  constructor(sqlite: Database.Database, recordReads: RecordReadModel, taskReads: TaskReadModel) {
    this.#projectCode = String(
      (
        sqlite.prepare("SELECT project_code FROM project_meta WHERE singleton = 1").get() as {
          project_code: string;
        }
      ).project_code,
    );
    this.#recordReads = recordReads;
    this.#taskReads = taskReads;
  }

  normalize(evidence: unknown[], strictTyped = false): unknown[] {
    return evidence.map((entry) => {
      let reference: Record<string, unknown>;
      if (strictTyped) {
        const parsed = EvidenceInputSchema.parse(entry);
        if (typeof parsed === "string") return parsed;
        reference = parsed;
      } else {
        if (typeof entry === "string") return entry;
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
        reference = entry as Record<string, unknown>;
      }
      if (reference.kind !== "atm_record" && reference.kind !== "atm_task") {
        return strictTyped ? reference : entry;
      }
      if (typeof reference.value !== "string" || !reference.value.trim()) {
        throw new AtmError("VALIDATION_ERROR", {
          message: `${String(reference.kind)} evidence value required`,
        });
      }
      if (reference.kind === "atm_record") {
        const normalized = reference.value.trim();
        const publicPrefix = `${this.#projectCode}-`;
        const publicSuffix = normalized.startsWith(publicPrefix)
          ? normalized.slice(publicPrefix.length)
          : "";
        if (!/^(?:D|R)-\d{3,}$/u.test(publicSuffix)) {
          throw new AtmError("RECORD_NOT_FOUND", {
            message: `Record 不存在：${reference.value}`,
            details: { entity: "RECORD", reference: reference.value },
          });
        }
        return { ...reference, value: this.#recordReads.getRecord(normalized).key };
      }
      const row = this.#taskReads.rowForTaskKey(reference.value);
      const taskKey = this.#taskReads.taskKeyForId(row.id);
      if (!taskKey)
        throw new AtmError("WORK_ITEM_NOT_FOUND", {
          message: `WorkItem 不存在：${reference.value}`,
          details: { entity: "WORK_ITEM", reference: reference.value },
        });
      return { ...reference, value: taskKey };
    });
  }
}

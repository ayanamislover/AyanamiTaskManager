import type { AyanamiTaskService } from "@ayanami-task/application";
import { AtmError } from "@ayanami-task/errors";
import {
  EvidenceInputSchema,
  RecordSubjectKeySchema,
  RecordTopicSchema,
} from "@ayanami-task/protocol";
import { z } from "zod";
import { mutationAck, wrap } from "../result.js";
import type { DefineProfileTool } from "./registrar.js";
import {
  opId,
  outputSchema,
  progressCompleted,
  projectCode,
  recordSummary,
  sessionId,
  taskKey,
} from "./schemas.js";

export function registerMemoryWriteTools(
  service: AyanamiTaskService,
  defineTool: DefineProfileTool,
): void {
  defineTool(
    "memory",
    "atm_progress_add",
    {
      description: "写任务或项目进度。",
      inputSchema: z
        .object({
          project: projectCode,
          session: sessionId,
          op_id: opId,
          scope: z.enum(["task", "project"]),
          task_key: taskKey.optional(),
          summary: z.string().min(1).max(500),
          percent: z.number().min(0).max(100).optional(),
          completed: z.array(progressCompleted).max(20).default([]),
          evidence: z.array(EvidenceInputSchema).max(20).default([]),
          health: z.enum(["ON_TRACK", "AT_RISK", "OFF_TRACK", "UNKNOWN"]).nullable().optional(),
          blocker: z.string().max(1000).nullable().optional(),
          next: z.array(z.string().max(500)).max(20).default([]),
        })
        .strict()
        .superRefine((value, context) => {
          if (value.scope === "task" && value.health !== undefined) {
            context.addIssue({
              code: "custom",
              path: ["health"],
              message: "health 仅适用于 project scope",
            });
          }
          if (value.scope === "project" && value.percent !== undefined) {
            context.addIssue({
              code: "custom",
              path: ["percent"],
              message: "percent 仅适用于 task scope",
            });
          }
        }),
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (input) => {
      const completed = input.completed.map((entry) =>
        typeof entry === "string"
          ? entry
          : {
              text: entry.text,
              ...(entry.work_item_key === undefined ? {} : { workItemKey: entry.work_item_key }),
            },
      );
      if (input.scope === "project") {
        const update = await service.addProjectProgress(input.project, input.session, input.op_id, {
          summary: input.summary,
          completed,
          next: input.next,
          ...(input.health === undefined ? {} : { health: input.health }),
          ...(input.blocker === undefined ? {} : { blocker: input.blocker }),
          evidence: input.evidence,
        });
        return wrap(
          mutationAck(
            input.project,
            input.session,
            input.op_id,
            "project-update.publish",
            update as unknown as Record<string, unknown>,
          ),
        );
      }
      if (!input.task_key)
        throw new AtmError("VALIDATION_ERROR", { message: "task scope 要求 task_key" });
      const updated = await service.addProgress(input.project, input.session, input.op_id, {
        taskKey: input.task_key,
        summary: input.summary,
        completed,
        next: input.next,
        evidence: input.evidence,
        ...(input.percent === undefined ? {} : { percent: input.percent }),
        ...(input.blocker === undefined ? {} : { blocker: input.blocker }),
      });
      return wrap(
        mutationAck(
          input.project,
          input.session,
          input.op_id,
          "work.progress",
          updated as unknown as Record<string, unknown>,
        ),
      );
    },
  );

  defineTool(
    "memory",
    "atm_record",
    {
      description: "保存关键记录。",
      inputSchema: z
        .object({
          project: projectCode,
          session: sessionId,
          op_id: opId,
          kind: z.enum(["DECISION", "CONSTRAINT", "FACT", "RISK", "REFERENCE", "LESSON"]),
          title: z.string().min(1).max(400),
          summary: recordSummary,
          detail: z.string().max(100_000).default(""),
          work_item_key: taskKey.nullable().optional(),
          supersedes: z.string().nullable().optional(),
          topic: RecordTopicSchema.nullable().optional(),
          subject_key: RecordSubjectKeySchema.nullable().optional(),
          importance: z.enum(["LOW", "NORMAL", "HIGH", "CRITICAL"]).default("NORMAL"),
          scope: z.string().max(100).default("PROJECT"),
        })
        .strict(),
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (input) => {
      const created = await service.createRecord(input.project, input.session, input.op_id, {
        kind: input.kind,
        title: input.title,
        summary: input.summary,
        detail: input.detail,
        importance: input.importance,
        scope: input.scope,
        ...(input.work_item_key === undefined ? {} : { workItemKey: input.work_item_key }),
        ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
        ...(input.topic === undefined ? {} : { topic: input.topic }),
        ...(input.subject_key === undefined ? {} : { subjectKey: input.subject_key }),
      });
      return wrap(
        mutationAck(
          input.project,
          input.session,
          input.op_id,
          "record.create",
          created as unknown as Record<string, unknown>,
        ),
      );
    },
  );
}

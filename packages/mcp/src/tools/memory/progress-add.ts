import type { AyanamiTaskService } from "@ayanami-task/application";
import { AtmError } from "@ayanami-task/errors";
import { EvidenceInputSchema } from "@ayanami-task/protocol";
import { z } from "zod";
import { mutationAck, wrap } from "../../result.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { opId, outputSchema, projectCode, sessionId, taskKey } from "../primitives.js";

const progressCompleted = z.union([
  z.string().max(500),
  z
    .object({
      text: z.string().trim().min(1).max(500),
      work_item_key: taskKey.optional(),
    })
    .strict(),
]);

const inputSchema = z
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
  });

export function createAtmProgressAddTool(
  service: AyanamiTaskService,
): ToolDefinition<typeof inputSchema> {
  return {
    profile: "memory",
    name: "atm_progress_add",
    description: "写任务或项目进度。",
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: async (input) => {
      const decoded = inputSchema.parse(input);
      const completed = decoded.completed.map((entry) =>
        typeof entry === "string"
          ? entry
          : {
              text: entry.text,
              ...(entry.work_item_key === undefined ? {} : { workItemKey: entry.work_item_key }),
            },
      );
      if (decoded.scope === "project") {
        const update = await service.addProjectProgress(
          decoded.project,
          decoded.session,
          decoded.op_id,
          {
            summary: decoded.summary,
            completed,
            next: decoded.next,
            ...(decoded.health === undefined ? {} : { health: decoded.health }),
            ...(decoded.blocker === undefined ? {} : { blocker: decoded.blocker }),
            evidence: decoded.evidence,
          },
        );
        return wrap(
          mutationAck(
            decoded.project,
            decoded.session,
            decoded.op_id,
            "project-update.publish",
            update as unknown as Record<string, unknown>,
          ),
        );
      }
      if (!decoded.task_key) {
        throw new AtmError("VALIDATION_ERROR", { message: "task scope 要求 task_key" });
      }
      const updated = await service.addProgress(decoded.project, decoded.session, decoded.op_id, {
        taskKey: decoded.task_key,
        summary: decoded.summary,
        completed,
        next: decoded.next,
        evidence: decoded.evidence,
        ...(decoded.percent === undefined ? {} : { percent: decoded.percent }),
        ...(decoded.blocker === undefined ? {} : { blocker: decoded.blocker }),
      });
      return wrap(
        mutationAck(
          decoded.project,
          decoded.session,
          decoded.op_id,
          "work.progress",
          updated as unknown as Record<string, unknown>,
        ),
      );
    },
  };
}

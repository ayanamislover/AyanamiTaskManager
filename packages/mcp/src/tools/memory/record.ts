import type { AyanamiTaskService } from "@ayanami-task/application";
import {
  RECORD_SUMMARY_CODE_POINT_LIMIT,
  RecordSubjectKeySchema,
  RecordSummarySchema,
  RecordTopicSchema,
  unicodeCodePointLength,
} from "@ayanami-task/protocol";
import { z } from "zod";
import { mutationAck, wrap } from "../../result.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { opId, outputSchema, projectCode, sessionId, taskKey } from "../primitives.js";

const recordSummary = RecordSummarySchema.superRefine((value, context) => {
  const actualLength = unicodeCodePointLength(value);
  if (actualLength <= RECORD_SUMMARY_CODE_POINT_LIMIT) return;
  context.addIssue({
    code: "custom",
    message: `INVALID_ARGUMENT ${JSON.stringify({
      actual_length: actualLength,
      limit: RECORD_SUMMARY_CODE_POINT_LIMIT,
      path: "summary",
    })}`,
  });
}).meta({ maxLength: RECORD_SUMMARY_CODE_POINT_LIMIT });

const inputSchema = z
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
  .strict();

export function createAtmRecordTool(
  service: AyanamiTaskService,
): ToolDefinition<typeof inputSchema> {
  return {
    profile: "memory",
    name: "atm_record",
    description: "保存关键记录。",
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: async (input) => {
      const decoded = inputSchema.parse(input);
      const created = await service.createRecord(decoded.project, decoded.session, decoded.op_id, {
        kind: decoded.kind,
        title: decoded.title,
        summary: decoded.summary,
        detail: decoded.detail,
        importance: decoded.importance,
        scope: decoded.scope,
        ...(decoded.work_item_key === undefined ? {} : { workItemKey: decoded.work_item_key }),
        ...(decoded.supersedes === undefined ? {} : { supersedes: decoded.supersedes }),
        ...(decoded.topic === undefined ? {} : { topic: decoded.topic }),
        ...(decoded.subject_key === undefined ? {} : { subjectKey: decoded.subject_key }),
      });
      return wrap(
        mutationAck(
          decoded.project,
          decoded.session,
          decoded.op_id,
          "record.create",
          created as unknown as Record<string, unknown>,
        ),
      );
    },
  };
}

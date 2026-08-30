import type { AyanamiTaskService } from "@ayanami-task/application";
import {
  RECORD_SUMMARY_CODE_POINT_LIMIT,
  RecordSummarySchema,
  unicodeCodePointLength,
} from "@ayanami-task/protocol";
import { z } from "zod";
import { mutationAck, wrap } from "../../result.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { opId, outputSchema, projectCode, sessionId, taskKey } from "../primitives.js";

const feedbackSummary = RecordSummarySchema.superRefine((value, context) => {
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
    summary: feedbackSummary,
    detail: z.string().max(50_000).default(""),
    severity: z.enum(["LOW", "NORMAL", "HIGH", "CRITICAL"]).default("NORMAL"),
    tool: z.string().trim().min(1).max(128).optional(),
    task_key: taskKey.optional(),
  })
  .strict();

function localFeedbackDetail(input: z.output<typeof inputSchema>): string {
  return [
    "本条反馈仅保存在本机 ATM 项目数据库，不会自动上传到任何外部服务。",
    ...(input.tool ? [`涉及工具：${input.tool}`] : []),
    "",
    input.detail || "未提供详细说明。",
  ].join("\n");
}

export function createAtmFeedbackTool(
  service: AyanamiTaskService,
): ToolDefinition<typeof inputSchema> {
  return {
    profile: "memory",
    name: "atm_feedback",
    description: "提交仅存本机的 ATM 使用反馈。",
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: async (input) => {
      const decoded = inputSchema.parse(input);
      const created = await service.createRecord(decoded.project, decoded.session, decoded.op_id, {
        kind: "RISK",
        title: `ATM Agent 反馈：${decoded.summary}`,
        summary: decoded.summary,
        detail: localFeedbackDetail(decoded),
        importance: decoded.severity,
        scope: "ATM_FEEDBACK",
        topic: "atm-agent-feedback",
        ...(decoded.task_key === undefined ? {} : { workItemKey: decoded.task_key }),
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

import type { AyanamiTaskService } from "@ayanami-task/application";
import { z } from "zod";
import {
  briefSectionNames,
  captureBriefRecordSnapshot,
  compactBriefTask,
  decodeBriefCursor,
  resolveBriefRecordSnapshot,
  validateBriefCursorRequest,
  type BriefSection,
} from "../../paging/brief-cursor.js";
import { continueWholeBrief, fitWholeBrief } from "../../paging/brief-fit.js";
import { wrap } from "../../result.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { outputSchema, projectCode, sessionId, taskKey } from "../primitives.js";

const inputSchema = z
  .object({
    project_code: projectCode,
    session_id: sessionId.optional(),
    task_key: taskKey.optional(),
    since_seq: z.number().int().nonnegative().optional(),
    cursor: z.string().min(1).optional(),
    max_chars: z.number().int().min(300).max(5000).default(1200),
    include: z.array(z.enum(briefSectionNames)).max(briefSectionNames.length).default([]),
  })
  .strict();

export function createAtmBriefTool(
  service: AyanamiTaskService,
): ToolDefinition<typeof inputSchema> {
  return {
    profile: "core",
    name: "atm_brief",
    description: "仅在上下文压缩、长时间离开或明确恢复 working set",
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: async (input) => {
      const decoded = inputSchema.parse(input);
      const decodedCursor = decoded.cursor === undefined ? null : decodeBriefCursor(decoded.cursor);
      if (decodedCursor) {
        validateBriefCursorRequest(decodedCursor, {
          project: decoded.project_code,
          ...(decoded.session_id === undefined ? {} : { sessionId: decoded.session_id }),
          include: decoded.include,
          ...(decoded.task_key === undefined ? {} : { taskKey: decoded.task_key }),
          ...(decoded.since_seq === undefined ? {} : { sinceSeq: decoded.since_seq }),
        });
      }
      const wanted = (section: BriefSection) =>
        decoded.include.length === 0 || decoded.include.includes(section);
      const withTask = decoded.task_key !== undefined && wanted("task");
      const withDelta = decoded.since_seq !== undefined && wanted("delta");
      const brief = await service.briefSnapshot(decoded.project_code, decoded.session_id);
      const detail = withTask
        ? {
            task: compactBriefTask(
              await service.getWorkItem(decoded.project_code, decoded.task_key!, "context"),
            ),
          }
        : {};
      const delta = withDelta
        ? { delta: await service.delta(decoded.project_code, decoded.since_seq!, 20) }
        : {};
      const payload = { ...brief, ...detail, ...delta };
      const frozenRecords = decodedCursor
        ? await resolveBriefRecordSnapshot(service, decoded.project_code, decodedCursor, brief)
        : null;
      const recordSnapshot = decodedCursor
        ? undefined
        : wanted("records")
          ? await captureBriefRecordSnapshot(service, decoded.project_code, brief)
          : [];
      const fitInput = {
        payload,
        include: decoded.include,
        maxChars: decoded.max_chars,
        project: decoded.project_code,
        ...(decoded.session_id === undefined ? {} : { sessionId: decoded.session_id }),
        ...(decoded.task_key === undefined ? {} : { taskKey: decoded.task_key }),
        ...(decoded.since_seq === undefined ? {} : { sinceSeq: decoded.since_seq }),
        ...(recordSnapshot === undefined ? {} : { recordSnapshot }),
      };
      return wrap(
        decodedCursor
          ? continueWholeBrief(decodedCursor, fitInput, frozenRecords ?? [])
          : fitWholeBrief({
              ...fitInput,
              identity: decoded.session_id === undefined ? {} : { session_id: decoded.session_id },
            }),
      );
    },
  };
}

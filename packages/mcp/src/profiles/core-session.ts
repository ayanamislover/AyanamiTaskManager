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
} from "../paging/brief-cursor.js";
import { continueWholeBrief, fitBegin, fitWholeBrief } from "../paging/brief-fit.js";
import { mcpResult as result, mutationAck, withMcpErrorDetails, wrap } from "../result.js";
import { MCP_SURFACE_VERSION } from "../surface.js";
import type { DefineProfileTool } from "./registrar.js";
import {
  beginExternal,
  beginToolInput,
  opId,
  outputSchema,
  projectCode,
  sessionId,
  taskKey,
} from "./schemas.js";

export function registerCoreBeginTools(
  service: AyanamiTaskService,
  defineTool: DefineProfileTool,
): void {
  defineTool(
    "core",
    "atm_begin",
    {
      description: "直接使用返回的 brief",
      inputSchema: beginToolInput,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (input) => {
      const { brief, ...externalInput } = input;
      const canonical = beginExternal.parse(externalInput);
      const beginInput = Object.fromEntries(
        Object.entries(canonical).filter(([, value]) => value !== undefined),
      ) as Parameters<AyanamiTaskService["begin"]>[0];
      const briefMode = z.enum(["none", "minimal", "full"]).parse(brief);
      const started = await withMcpErrorDetails(
        service,
        canonical.projectCode === undefined ? {} : { project: canonical.projectCode },
        () => service.begin(beginInput),
      );
      if (started.scope === "quick") {
        return result(
          {
            scope: "quick",
            quick: started.quick.key,
            status: started.quick.status,
            version: started.quick.version,
            surface_version: MCP_SURFACE_VERSION,
            ...(canonical.operationId === undefined ? {} : { op_id: canonical.operationId }),
          },
          1200,
        );
      }
      const snapshot = await service.briefSnapshot(
        String(started.project),
        String(started.session),
      );
      const recordSnapshot =
        briefMode === "full"
          ? await captureBriefRecordSnapshot(service, String(started.project), snapshot)
          : [];
      const { score: _classificationScore, ...beginIdentity } = started;
      void _classificationScore;
      return wrap(
        fitBegin({ ...beginIdentity, ...snapshot }, briefMode, canonical.maxChars, recordSnapshot),
      );
    },
  );

  defineTool(
    "core",
    "atm_brief",
    {
      description: "仅在上下文压缩、长时间离开或明确恢复 working set",
      inputSchema: z
        .object({
          project_code: projectCode,
          session_id: sessionId.optional(),
          task_key: taskKey.optional(),
          since_seq: z.number().int().nonnegative().optional(),
          cursor: z.string().min(1).optional(),
          max_chars: z.number().int().min(300).max(5000).default(1200),
          include: z.array(z.enum(briefSectionNames)).max(briefSectionNames.length).default([]),
        })
        .strict(),
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (input) => {
      const decodedCursor = input.cursor === undefined ? null : decodeBriefCursor(input.cursor);
      if (decodedCursor) {
        validateBriefCursorRequest(decodedCursor, {
          project: input.project_code,
          ...(input.session_id === undefined ? {} : { sessionId: input.session_id }),
          include: input.include,
          ...(input.task_key === undefined ? {} : { taskKey: input.task_key }),
          ...(input.since_seq === undefined ? {} : { sinceSeq: input.since_seq }),
        });
      }
      const wanted = (section: BriefSection) =>
        input.include.length === 0 || input.include.includes(section);
      const withTask = input.task_key !== undefined && wanted("task");
      const withDelta = input.since_seq !== undefined && wanted("delta");
      const brief = await service.briefSnapshot(input.project_code, input.session_id);
      const detail = withTask
        ? {
            task: compactBriefTask(
              await service.getWorkItem(input.project_code, input.task_key!, "context"),
            ),
          }
        : {};
      const delta = withDelta
        ? { delta: await service.delta(input.project_code, input.since_seq!, 20) }
        : {};
      const payload = { ...brief, ...detail, ...delta };
      const frozenRecords = decodedCursor
        ? await resolveBriefRecordSnapshot(service, input.project_code, decodedCursor, brief)
        : null;
      const recordSnapshot = decodedCursor
        ? undefined
        : wanted("records")
          ? await captureBriefRecordSnapshot(service, input.project_code, brief)
          : [];
      const fitInput = {
        payload,
        include: input.include,
        maxChars: input.max_chars,
        project: input.project_code,
        ...(input.session_id === undefined ? {} : { sessionId: input.session_id }),
        ...(input.task_key === undefined ? {} : { taskKey: input.task_key }),
        ...(input.since_seq === undefined ? {} : { sinceSeq: input.since_seq }),
        ...(recordSnapshot === undefined ? {} : { recordSnapshot }),
      };
      return wrap(
        decodedCursor
          ? continueWholeBrief(decodedCursor, fitInput, frozenRecords ?? [])
          : fitWholeBrief({
              ...fitInput,
              identity: input.session_id === undefined ? {} : { session_id: input.session_id },
            }),
      );
    },
  );
}

export function registerCoreEndTool(
  service: AyanamiTaskService,
  defineTool: DefineProfileTool,
): void {
  defineTool(
    "core",
    "atm_end",
    {
      description: "结束会话并交接。",
      inputSchema: z
        .object({
          project: projectCode,
          session: sessionId,
          op_id: opId,
          outcome: z.enum(["completed", "paused", "blocked", "cancelled", "error", "retired"]),
          summary: z.string().min(1).max(500),
          next: z.array(z.string().max(500)).max(20).default([]),
          release_claims: z.boolean().default(true),
          retirement_reason: z.string().max(500).nullable().optional(),
        })
        .strict(),
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (input) => {
      const ended = await service.end(input.project, input.session, input.op_id, {
        outcome: input.outcome,
        summary: input.summary,
        next: input.next,
        releaseClaims: input.release_claims,
        ...(input.retirement_reason === undefined
          ? {}
          : { retirementReason: input.retirement_reason }),
      });
      return wrap(
        mutationAck(
          input.project,
          input.session,
          input.op_id,
          "session.end",
          ended as unknown as Record<string, unknown>,
        ),
      );
    },
  );
}

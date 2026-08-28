import type { AyanamiTaskService } from "@ayanami-task/application";
import {
  BeginInputSchema,
  BeginSignalsSchema,
  externalizeObjectSchema,
  type ExternalNameMap,
} from "@ayanami-task/protocol";
import { z } from "zod";
import { captureBriefRecordSnapshot } from "../../paging/brief-cursor.js";
import { fitBegin } from "../../paging/brief-fit.js";
import { mcpResult as result, wrap } from "../../result.js";
import { MCP_SURFACE_VERSION } from "../../surface.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { outputSchema } from "../primitives.js";

const beginSignalNames = {
  expectedMinutes: "expected_minutes",
  subtaskCount: "subtask_count",
  multiSession: "multi_session",
  multiAgent: "multi_agent",
  hasDependencies: "has_dependencies",
  needsEvidence: "needs_evidence",
  hasTargetDate: "has_target_date",
} as const satisfies ExternalNameMap<typeof BeginSignalsSchema>;
const beginSignalsExternal = externalizeObjectSchema(BeginSignalsSchema, beginSignalNames);

const beginNames = {
  operationId: "op_id",
  cwd: "cwd",
  projectCode: "project_code",
  title: "title",
  mode: "mode",
  agentId: "agent_id",
  displayName: "display_name",
  clientKind: "client_kind",
  threadId: "thread_id",
  parentSessionId: "parent_session_id",
  resume: "resume",
  predecessorSessionId: "predecessor_session_id",
  maxChars: "max_chars",
  role: "role",
  signals: "signals",
  allowProjectCreate: "allow_project_create",
  creationReason: "creation_reason",
} as const satisfies ExternalNameMap<typeof BeginInputSchema>;
const beginExternal = externalizeObjectSchema(BeginInputSchema, beginNames, {
  signals: {
    schema: beginSignalsExternal.inputSchema.default({}),
    decode: (value) => beginSignalsExternal.parse(value),
  },
});
const beginFields = beginExternal.inputSchema.shape;
const inputSchema = z
  .object({
    op_id: beginFields.op_id!,
    cwd: beginFields.cwd!,
    project_code: beginFields.project_code!,
    title: beginFields.title!,
    mode: beginFields.mode!,
    agent_id: beginFields.agent_id!,
    display_name: beginFields.display_name!,
    client_kind: beginFields.client_kind!,
    thread_id: beginFields.thread_id!,
    parent_session_id: beginFields.parent_session_id!,
    resume: beginFields.resume!,
    brief: z.enum(["none", "minimal", "full"]).default("full"),
    max_chars: beginFields.max_chars!,
    predecessor_session_id: beginFields.predecessor_session_id!,
    role: beginFields.role!,
    signals: beginFields.signals!,
    allow_project_create: beginFields.allow_project_create!,
    creation_reason: beginFields.creation_reason!,
  })
  .strict();

export function createAtmBeginTool(
  service: AyanamiTaskService,
): ToolDefinition<typeof inputSchema> {
  return {
    profile: "core",
    name: "atm_begin",
    description: "直接使用返回的 brief",
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: async (input) => {
      const decoded = inputSchema.parse(input);
      const { brief, ...externalInput } = decoded;
      const canonical = beginExternal.parse(externalInput);
      const beginInput = Object.fromEntries(
        Object.entries(canonical).filter(([, value]) => value !== undefined),
      ) as Parameters<AyanamiTaskService["begin"]>[0];
      const started = await service.begin(beginInput);
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
        brief === "full"
          ? await captureBriefRecordSnapshot(service, String(started.project), snapshot)
          : [];
      const { score: _classificationScore, ...beginIdentity } = started;
      void _classificationScore;
      return wrap(
        fitBegin({ ...beginIdentity, ...snapshot }, brief, canonical.maxChars, recordSnapshot),
      );
    },
  };
}

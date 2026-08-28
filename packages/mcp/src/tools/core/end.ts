import type { AyanamiTaskService } from "@ayanami-task/application";
import { z } from "zod";
import { mutationAck, wrap } from "../../result.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { opId, outputSchema, projectCode, sessionId } from "../primitives.js";

const inputSchema = z
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
  .strict();

export function createAtmEndTool(service: AyanamiTaskService): ToolDefinition<typeof inputSchema> {
  return {
    profile: "core",
    name: "atm_end",
    description: "结束会话并交接。",
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: async (input) => {
      const decoded = inputSchema.parse(input);
      const ended = await service.end(decoded.project, decoded.session, decoded.op_id, {
        outcome: decoded.outcome,
        summary: decoded.summary,
        next: decoded.next,
        releaseClaims: decoded.release_claims,
        ...(decoded.retirement_reason === undefined
          ? {}
          : { retirementReason: decoded.retirement_reason }),
      });
      return wrap(
        mutationAck(
          decoded.project,
          decoded.session,
          decoded.op_id,
          "session.end",
          ended as unknown as Record<string, unknown>,
        ),
      );
    },
  };
}

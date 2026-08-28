import type { AyanamiTaskService } from "@ayanami-task/application";
import { z } from "zod";
import { fitDelta } from "../../paging/delta.js";
import { wrap } from "../../result.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { outputSchema, projectCode } from "../primitives.js";

const inputSchema = z
  .object({
    project: projectCode,
    since_seq: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(100).default(50),
    types: z.array(z.string()).max(50).default([]),
    max_chars: z.number().int().min(1000).max(50_000).default(12_000),
  })
  .strict();

export function createAtmDeltaTool(
  service: AyanamiTaskService,
): ToolDefinition<typeof inputSchema> {
  return {
    profile: "memory",
    name: "atm_delta",
    description: "读增量变化。",
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: async (input) => {
      const decoded = inputSchema.parse(input);
      const delta = (await service.delta(
        decoded.project,
        decoded.since_seq,
        decoded.limit,
        decoded.types,
      )) as Record<string, unknown>;
      return wrap(
        fitDelta(decoded.project, decoded.since_seq, decoded.limit, decoded.max_chars, delta),
      );
    },
  };
}

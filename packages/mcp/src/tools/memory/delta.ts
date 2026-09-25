import type { AyanamiTaskService } from "@ayanami-task/application";
import { z } from "zod";
import { fitDelta } from "../../paging/delta.js";
import { wrap } from "../../result.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { outputSchema, projectCode } from "../primitives.js";

const inputSchema = z
  .object({
    project: projectCode,
    since_seq: z.number().int().nonnegative().optional(),
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
    description:
      "读增量变化。省略 since_seq 时返回最近 limit 条。",
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: async (input) => {
      const decoded = inputSchema.parse(input);
      const delta = (await service.delta(
        decoded.project,
        decoded.since_seq ?? null,
        decoded.limit,
        decoded.types,
      )) as Record<string, any>;
      if (decoded.since_seq !== undefined) {
        return wrap(
          fitDelta(decoded.project, decoded.since_seq, decoded.limit, decoded.max_chars, delta),
        );
      }
      // 最新窗口：把窗口起点换算成等价的 since_seq，后续分页与带 since_seq 的请求同构。
      const first = Array.isArray(delta.events) ? delta.events[0] : undefined;
      const windowStart =
        first === undefined
          ? Number(delta.currentSequence ?? 0)
          : Math.max(0, Number(first.seq) - 1);
      const tag = { window: "latest" };
      // 追加 tag 多出 `,"window":"latest"`：去掉 tag 自己的一对花括号，再补一个逗号。
      const tagChars = JSON.stringify(tag).length - 1;
      return wrap({
        ...fitDelta(
          decoded.project,
          windowStart,
          decoded.limit,
          decoded.max_chars - tagChars,
          delta,
        ),
        ...tag,
      });
    },
  };
}

import type { AyanamiTaskService } from "@ayanami-task/application";
import { z } from "zod";
import {
  fieldTargetVersion,
  fitFieldRead,
  ignoredFields,
  ignoredFieldsCost,
  selectFields,
} from "../../paging/field.js";
import { externalizeTaskView } from "../../paging/task.js";
import { wrap } from "../../result.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { outputSchema, projectCode, taskKey } from "../primitives.js";

/** max_chars 的下限，与 schema 同源：扣掉回显开销后也不降到它以下。 */
const TASK_GET_MIN_CHARS = 300;

const inputSchema = z
  .object({
    project: projectCode,
    task_key: taskKey,
    view: z.enum(["core", "context", "full"]).default("core"),
    field_mask: z.array(z.string().max(64)).max(30).default([]),
    cursor: z.string().max(2000).optional(),
    max_chars: z.number().int().min(TASK_GET_MIN_CHARS).max(50_000).default(12_000),
  })
  .strict();

export function createAtmTaskGetTool(
  service: AyanamiTaskService,
): ToolDefinition<typeof inputSchema> {
  return {
    profile: "core",
    name: "atm_task_get",
    description:
      "读单个任务。view=core|context|full。field_mask 在 view 已有的字段内过滤，越界字段会回显在 ignored_fields。",
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: async (input) => {
      const decoded = inputSchema.parse(input);
      const item = await service.getWorkItem(decoded.project, decoded.task_key, decoded.view);
      const externalItem = externalizeTaskView(item) as Record<string, unknown>;
      const projected = selectFields(externalItem, decoded.field_mask);
      const ignored = ignoredFields(externalItem, decoded.field_mask);
      // max_chars 是整个响应的上限，回显的越界字段也得从这个额度里出，
      // 否则「说清楚少了什么」会把响应顶出调用方给的预算。
      const fitted = fitFieldRead(
        projected,
        Math.max(decoded.max_chars - ignoredFieldsCost(ignored), TASK_GET_MIN_CHARS),
        "atm_task_get",
        {
          project: decoded.project,
          entity: decoded.task_key,
          entityType: "WORK_ITEM",
          fieldMask: [`@view:${decoded.view}`, ...decoded.field_mask],
          targetVersion: fieldTargetVersion(externalItem),
        },
        decoded.cursor,
      );
      return wrap(ignored.length === 0 ? fitted : { ...fitted, ignored_fields: ignored });
    },
  };
}

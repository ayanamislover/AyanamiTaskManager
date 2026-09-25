import type { AyanamiTaskService } from "@ayanami-task/application";
import { z } from "zod";
import {
  fieldTargetVersion,
  fitFieldRead,
  fitIgnoredFields,
  ignoredFields,
  selectFields,
} from "../../paging/field.js";
import { compactProgress } from "../../paging/entities.js";
import { externalizeTaskView } from "../../paging/task.js";
import { plain, wrap } from "../../result.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { outputSchema, projectCode, taskKey } from "../primitives.js";

/** max_chars 的下限，只管住入参；回显与正文如何分这份额度由 fitIgnoredFields 决定。 */
const TASK_GET_MIN_CHARS = 300;

const inputSchema = z
  .object({
    project: projectCode,
    task_key: taskKey,
    view: z.enum(["core", "context", "full"]).default("core"),
    field_mask: z.array(z.string().max(64)).max(30).default([]),
    cursor: z.string().max(2000).optional(),
    last_progress: z.number().int().min(1).max(10).optional(),
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
      "读单个任务。view=core|context|full。field_mask 在 view 已有的字段内过滤，越界字段会回显在 ignored_fields。last_progress=N 附带最近 N 条进度。",
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: async (input) => {
      const decoded = inputSchema.parse(input);
      const item = await service.getWorkItem(decoded.project, decoded.task_key, decoded.view);
      const externalItem = externalizeTaskView(item) as Record<string, unknown>;
      // 进度不属于任何 view，只在点名时附带，因此放在 field_mask 过滤之后，也不参与 ignored_fields。
      const projected =
        decoded.last_progress === undefined
          ? selectFields(externalItem, decoded.field_mask)
          : {
              ...selectFields(externalItem, decoded.field_mask),
              recent_progress: (
                await service.recentTaskProgress(
                  decoded.project,
                  decoded.task_key,
                  decoded.last_progress,
                )
              ).map((progress) => {
                const { task_key: _taskKey, ...rest } = compactProgress(plain(progress));
                void _taskKey;
                return rest;
              }),
            };
      const ignored = ignoredFields(externalItem, decoded.field_mask);
      // max_chars 是整个响应的上限，回显的越界字段也得从这个额度里出，
      // 否则「说清楚少了什么」会把响应顶出调用方给的预算。
      const { echo, cost } = fitIgnoredFields(ignored, decoded.max_chars);
      const fitted = fitFieldRead(
        projected,
        decoded.max_chars - cost,
        "atm_task_get",
        {
          project: decoded.project,
          entity: decoded.task_key,
          entityType: "WORK_ITEM",
          fieldMask: [
            `@view:${decoded.view}`,
            ...(decoded.last_progress === undefined ? [] : [`@progress:${decoded.last_progress}`]),
            ...decoded.field_mask,
          ],
          targetVersion: fieldTargetVersion(externalItem),
        },
        decoded.cursor,
      );
      return wrap({ ...fitted, ...echo });
    },
  };
}

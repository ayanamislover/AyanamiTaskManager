import type { AyanamiTaskService } from "@ayanami-task/application";
import { z } from "zod";
import { fieldTargetVersion, fitFieldRead, selectFields } from "../../paging/field.js";
import { externalizeTaskView } from "../../paging/task.js";
import { wrap } from "../../result.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { outputSchema, projectCode, taskKey } from "../primitives.js";

const inputSchema = z
  .object({
    project: projectCode,
    task_key: taskKey,
    view: z.enum(["core", "context", "full"]).default("core"),
    field_mask: z.array(z.string()).max(30).default([]),
    cursor: z.string().max(2000).optional(),
    max_chars: z.number().int().min(300).max(50_000).default(12_000),
  })
  .strict();

export function createAtmTaskGetTool(
  service: AyanamiTaskService,
): ToolDefinition<typeof inputSchema> {
  return {
    profile: "core",
    name: "atm_task_get",
    description: "读单个任务。",
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: async (input) => {
      const decoded = inputSchema.parse(input);
      const item = await service.getWorkItem(decoded.project, decoded.task_key, decoded.view);
      const externalItem = externalizeTaskView(item) as Record<string, unknown>;
      const projected = selectFields(externalItem, decoded.field_mask);
      return wrap(
        fitFieldRead(
          projected,
          decoded.max_chars,
          "atm_task_get",
          {
            project: decoded.project,
            entity: decoded.task_key,
            entityType: "WORK_ITEM",
            fieldMask: [`@view:${decoded.view}`, ...decoded.field_mask],
            targetVersion: fieldTargetVersion(externalItem),
          },
          decoded.cursor,
        ),
      );
    },
  };
}

import type { AyanamiTaskService } from "@ayanami-task/application";
import { z } from "zod";
import { ignoredFields, ignoredFieldsCost, selectFields } from "../../paging/field.js";
import {
  compactReconciliationItem,
  externalizeTaskView,
  fitReconciliationPage,
  fitTaskPage,
  type TaskProjectionView,
} from "../../paging/task.js";
import { plain, wrap } from "../../result.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { outputSchema, projectCode, taskKey } from "../primitives.js";

/** max_chars 的下限，与 schema 同源：扣掉回显开销后也不降到它以下。 */
const TASK_LIST_MIN_CHARS = 500;

const inputSchema = z
  .object({
    project: projectCode,
    status: z.string().optional(),
    owner: z.string().optional(),
    parent_key: taskKey.optional(),
    milestone_id: z.string().optional(),
    ready_only: z.boolean().default(false),
    query: z.string().max(500).optional(),
    limit: z.number().int().min(1).max(100).default(10),
    cursor: z.string().optional(),
    view: z.enum(["core", "context", "full", "reconcile"]).default("core"),
    include_active: z.boolean().default(false),
    field_mask: z.array(z.string().max(64)).max(20).default([]),
    max_chars: z.number().int().min(TASK_LIST_MIN_CHARS).max(50_000).default(12_000),
  })
  .strict();

export function createAtmTaskListTool(
  service: AyanamiTaskService,
): ToolDefinition<typeof inputSchema> {
  return {
    profile: "core",
    name: "atm_task_list",
    description: "分页列任务。view=core|context|full|reconcile。field_mask 语义同 atm_task_get。",
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: async (input) => {
      const decoded = inputSchema.parse(input);
      if (decoded.view === "reconcile") {
        const page = plain(
          await service.reconcileProjectPage(decoded.project, {
            includeActive: decoded.include_active,
            limit: decoded.limit,
            ...(decoded.cursor === undefined ? {} : { cursor: decoded.cursor }),
          }),
        );
        const items = Array.isArray(page.items)
          ? (page.items as Array<Record<string, unknown>>)
          : [];
        const projected = items.map((item) =>
          selectFields(compactReconciliationItem(item), decoded.field_mask),
        );
        return wrap(
          fitReconciliationPage(
            decoded.project,
            page,
            Number(page.offset ?? 0),
            decoded.max_chars,
            projected,
            page.hasMore === true,
          ),
        );
      }
      const projectionView: TaskProjectionView = decoded.view;
      const filters = {
        readyOnly: decoded.ready_only,
        limit: decoded.limit,
        ...(decoded.cursor === undefined ? {} : { cursor: decoded.cursor }),
        ...(decoded.status === undefined ? {} : { status: decoded.status }),
        ...(decoded.owner === undefined ? {} : { assigneeAgentId: decoded.owner }),
        ...(decoded.parent_key === undefined ? {} : { parentKey: decoded.parent_key }),
        ...(decoded.milestone_id === undefined ? {} : { milestoneId: decoded.milestone_id }),
        ...(decoded.query === undefined ? {} : { query: decoded.query }),
      };
      const page = await service.listWorkItemPage(decoded.project, filters, projectionView);
      const externalItems = page.items.map(
        (item) => externalizeTaskView(item) as Record<string, unknown>,
      );
      const projectedItems = externalItems.map((item) => selectFields(item, decoded.field_mask));
      // 这一页所有条目共用一个 view 形状，用第一条判断就够；空页没有形状可判。
      const ignored =
        externalItems[0] === undefined ? [] : ignoredFields(externalItems[0], decoded.field_mask);
      const fitted = fitTaskPage(
        decoded.project,
        projectionView,
        Math.max(decoded.max_chars - ignoredFieldsCost(ignored), TASK_LIST_MIN_CHARS),
        projectedItems,
        page.itemCursors,
        page.hasMore,
        page.nextCursor,
        page.retryCursor,
      );
      return wrap(ignored.length === 0 ? fitted : { ...fitted, ignored_fields: ignored });
    },
  };
}

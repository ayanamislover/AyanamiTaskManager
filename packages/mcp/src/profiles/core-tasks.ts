import type { AyanamiTaskService } from "@ayanami-task/application";
import { z } from "zod";
import { fieldTargetVersion, fitFieldRead, selectFields } from "../paging/field.js";
import {
  compactReconciliationItem,
  externalizeTaskView,
  fitReconciliationPage,
  fitTaskPage,
  type TaskProjectionView,
} from "../paging/task.js";
import { mutationAck, plain, wrap } from "../result.js";
import type { DefineProfileTool } from "./registrar.js";
import { outputSchema, projectCode, taskCreateExternal, taskKey } from "./schemas.js";

export function registerCoreTaskTools(
  service: AyanamiTaskService,
  defineTool: DefineProfileTool,
): void {
  defineTool(
    "core",
    "atm_task_list",
    {
      description: "分页列任务。",
      inputSchema: z
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
          field_mask: z.array(z.string()).max(20).default([]),
          max_chars: z.number().int().min(500).max(50_000).default(12_000),
        })
        .strict(),
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (input) => {
      if (input.view === "reconcile") {
        const offset = Math.max(0, Number.parseInt(input.cursor ?? "0", 10) || 0);
        const reconciliation = plain(
          await service.reconcileProject(input.project, { includeActive: input.include_active }),
        );
        const allItems = Array.isArray(reconciliation.items)
          ? (reconciliation.items as Array<Record<string, any>>)
          : [];
        const page = allItems.slice(offset, offset + input.limit);
        const projected = page.map((item) =>
          selectFields(compactReconciliationItem(item), input.field_mask),
        );
        return wrap(
          fitReconciliationPage(
            input.project,
            reconciliation,
            offset,
            input.max_chars,
            projected,
            offset + page.length < allItems.length,
          ),
        );
      }
      const projectionView: TaskProjectionView = input.view;
      const filters = {
        readyOnly: input.ready_only,
        limit: input.limit,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.owner === undefined ? {} : { assigneeAgentId: input.owner }),
        ...(input.parent_key === undefined ? {} : { parentKey: input.parent_key }),
        ...(input.milestone_id === undefined ? {} : { milestoneId: input.milestone_id }),
        ...(input.query === undefined ? {} : { query: input.query }),
      };
      const page = await service.listWorkItemPage(input.project, filters, projectionView);
      const projectedItems = page.items.map((item) =>
        selectFields(externalizeTaskView(item) as Record<string, unknown>, input.field_mask),
      );
      return wrap(
        fitTaskPage(
          input.project,
          projectionView,
          input.max_chars,
          projectedItems,
          page.itemCursors,
          page.hasMore,
          page.nextCursor,
          page.retryCursor,
        ),
      );
    },
  );

  defineTool(
    "core",
    "atm_task_get",
    {
      description: "读单个任务。",
      inputSchema: z
        .object({
          project: projectCode,
          task_key: taskKey,
          view: z.enum(["core", "context", "full"]).default("core"),
          field_mask: z.array(z.string()).max(30).default([]),
          cursor: z.string().max(2000).optional(),
          max_chars: z.number().int().min(300).max(50_000).default(12_000),
        })
        .strict(),
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (input) => {
      const item = await service.getWorkItem(input.project, input.task_key, input.view);
      const externalItem = externalizeTaskView(item) as Record<string, unknown>;
      const projected = selectFields(externalItem, input.field_mask);
      return wrap(
        fitFieldRead(
          projected,
          input.max_chars,
          "atm_task_get",
          {
            project: input.project,
            entity: input.task_key,
            entityType: "WORK_ITEM",
            fieldMask: [`@view:${input.view}`, ...input.field_mask],
            targetVersion: fieldTargetVersion(externalItem),
          },
          input.cursor,
        ),
      );
    },
  );

  defineTool(
    "core",
    "atm_task_create",
    {
      description: "批量创建任务与关系。",
      inputSchema: taskCreateExternal.inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (input) => {
      const canonical = taskCreateExternal.parse(input);
      const canonicalItems = canonical.items.map((item) =>
        Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined)),
      ) as Parameters<AyanamiTaskService["createWorkItems"]>[3];
      const created = await service.createWorkItems(
        canonical.project,
        canonical.session,
        canonical.opId,
        canonicalItems,
        { resolvePlanningRoot: true },
      );
      return wrap(
        mutationAck(
          canonical.project,
          canonical.session,
          canonical.opId,
          "work.create.batch",
          created as unknown as Record<string, unknown>,
        ),
      );
    },
  );
}

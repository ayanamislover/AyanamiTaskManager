import type { AyanamiTaskService } from "@ayanami-task/application";
import {
  ChecklistCreateInputSchema,
  externalizeObjectSchema,
  type ExternalNameMap,
  TaskCreateBatchInputSchema,
  WorkItemCreateInputSchema,
} from "@ayanami-task/protocol";
import { z } from "zod";
import { mutationAck, wrap } from "../../result.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { outputSchema } from "../primitives.js";

const checklistCreateNames = {
  title: "title",
  evidenceRequired: "evidence_required",
  weight: "weight",
} as const satisfies ExternalNameMap<typeof ChecklistCreateInputSchema>;
const checklistCreateExternal = externalizeObjectSchema(
  ChecklistCreateInputSchema,
  checklistCreateNames,
);

const workItemCreateNames = {
  clientRef: "client_ref",
  objectiveId: "objective_id",
  milestoneId: "milestone_id",
  parentKey: "parent_key",
  parentRef: "parent_ref",
  dependsOn: "depends_on",
  dependsOnRefs: "depends_on_refs",
  discoveredFrom: "discovered_from",
  discoveredFromRef: "discovered_from_ref",
  title: "title",
  description: "description",
  type: "type",
  priority: "priority",
  status: "status",
  acceptance: "acceptance",
  checklist: "checklist",
  weight: "weight",
  targetDate: "target_date",
  verificationRequired: "verification_required",
  assigneeAgentId: "assignee_agent_id",
} as const satisfies ExternalNameMap<typeof WorkItemCreateInputSchema>;
const workItemCreateExternal = externalizeObjectSchema(
  WorkItemCreateInputSchema,
  workItemCreateNames,
  {
    checklist: {
      schema: z.array(checklistCreateExternal.inputSchema).max(100).default([]),
      decode: (value) =>
        (value as unknown[]).map((checklistItem) => checklistCreateExternal.parse(checklistItem)),
    },
  },
);

const taskCreateNames = {
  project: "project",
  session: "session",
  opId: "op_id",
  items: "items",
} as const satisfies ExternalNameMap<typeof TaskCreateBatchInputSchema>;
const taskCreateExternal = externalizeObjectSchema(TaskCreateBatchInputSchema, taskCreateNames, {
  items: {
    schema: z.array(workItemCreateExternal.inputSchema).min(1).max(50),
    decode: (value) =>
      (value as unknown[]).map((workItem) => workItemCreateExternal.parse(workItem)),
  },
});
const inputSchema = taskCreateExternal.inputSchema;

export function createAtmTaskCreateTool(
  service: AyanamiTaskService,
): ToolDefinition<typeof inputSchema> {
  return {
    profile: "core",
    name: "atm_task_create",
    description: "批量创建任务与关系。",
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: async (input) => {
      const decoded = inputSchema.parse(input);
      const canonical = taskCreateExternal.parse(decoded);
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
  };
}

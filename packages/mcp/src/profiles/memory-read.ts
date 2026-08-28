import type { AyanamiTaskService } from "@ayanami-task/application";
import { AtmError } from "@ayanami-task/errors";
import { z } from "zod";
import { fitDelta } from "../paging/delta.js";
import {
  compactOperationTrace,
  compactProgress,
  compactRecord,
  compactSession,
  compactSessionPageItem,
  fitRecordPage,
  fitSessionPage,
  scopedUlidQuery,
} from "../paging/entities.js";
import { fieldTargetVersion, fitFieldRead, selectFields } from "../paging/field.js";
import {
  fitSearchPage,
  projectFromPublicKey,
  publicKeyKind,
  type SearchServicePage,
} from "../paging/search.js";
import { plain, wrap } from "../result.js";
import type { DefineProfileTool } from "./registrar.js";
import { opId, outputSchema, projectCode, sessionId } from "./schemas.js";

export function registerMemoryReadTools(
  service: AyanamiTaskService,
  defineTool: DefineProfileTool,
): void {
  defineTool(
    "memory",
    "atm_search",
    {
      description: "搜索事实。",
      inputSchema: z
        .object({
          list: z.enum(["records", "sessions"]).optional(),
          project: projectCode.optional(),
          query: z.string().trim().min(1).max(500).optional(),
          op_id: opId.optional(),
          session: sessionId.optional(),
          limit: z.number().int().min(1).max(30).default(20),
          cursor: z.string().optional(),
          field_mask: z.array(z.string()).max(20).default([]),
          max_chars: z.number().int().min(300).max(50_000).default(6000),
        })
        .strict()
        .superRefine((value, context) => {
          if (value.list !== undefined) {
            if (value.project === undefined) {
              context.addIssue({
                code: "custom",
                path: ["project"],
                message: `list=${value.list} 要求 project`,
              });
            }
            for (const field of ["query", "op_id", "session"] as const) {
              if (value[field] !== undefined) {
                context.addIssue({
                  code: "custom",
                  path: [field],
                  message: `list=${value.list} 时 ${field} 必须省略`,
                });
              }
            }
            return;
          }
          if (value.query === undefined && value.op_id === undefined) {
            context.addIssue({
              code: "custom",
              path: ["query"],
              message: "query 或 op_id 至少提供一个",
            });
            context.addIssue({
              code: "custom",
              path: ["op_id"],
              message: "query 或 op_id 至少提供一个",
            });
          }
          if (value.session !== undefined && value.op_id === undefined) {
            context.addIssue({
              code: "custom",
              path: ["session"],
              message: "session 仅可与 op_id 精确回查一起使用",
            });
          }
        }),
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (input) => {
      if (input.list === "records") {
        const page = await service.recordPage(input.project!, {
          limit: input.limit,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        });
        const listFieldMask =
          input.field_mask.length > 0
            ? input.field_mask
            : [
                "key",
                "kind",
                "title",
                "summary",
                "importance",
                "status",
                "topic",
                "subject_key",
                "source_type",
                "updated_at",
              ];
        const projectedItems = page.items.map((record) =>
          selectFields(compactRecord(plain(record)), listFieldMask),
        );
        return wrap(
          fitRecordPage(
            input.project!,
            input.limit,
            input.max_chars,
            projectedItems,
            page.itemCursors,
            page.hasMore,
            page.nextCursor,
            page.retryCursor,
          ),
        );
      }
      if (input.list === "sessions") {
        const page = await service.agentPage(input.project!, {
          limit: input.limit,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        });
        const listFieldMask =
          input.field_mask.length > 0
            ? input.field_mask
            : [
                "id",
                "agent_id",
                "display_name",
                "client_kind",
                "role",
                "work_state",
                "connection_state",
                "current_task_key",
                "last_seen_at",
                "started_at",
                "updated_at",
              ];
        const projectedItems = page.items.map((session) =>
          selectFields(compactSessionPageItem(plain(session)), listFieldMask),
        );
        return wrap(
          fitSessionPage(
            input.project!,
            input.limit,
            input.max_chars,
            projectedItems,
            page.itemCursors,
            page.hasMore,
            page.nextCursor,
            page.retryCursor,
          ),
        );
      }
      if (input.op_id !== undefined) {
        if (!input.project)
          throw new AtmError("PROJECT_REQUIRED", { message: "op_id 精确回查要求 project" });
        const trace = compactOperationTrace(
          plain(await service.getOperationTrace(input.project, input.op_id, input.session)),
        );
        const source = selectFields(trace, input.field_mask);
        const fitted = fitFieldRead(
          source,
          Math.max(300, input.max_chars - 80),
          "atm_search",
          {
            project: input.project,
            entity: `${input.op_id}@${input.session ?? "*"}`,
            entityType: "OPERATION",
            fieldMask: input.field_mask,
            targetVersion: fieldTargetVersion(trace),
          },
          input.cursor,
        );
        return wrap({ exact: true, entity_type: "OPERATION", operation: fitted });
      }
      if (!input.query)
        throw new AtmError("VALIDATION_ERROR", { message: "query 或 op_id 至少提供一个" });
      if (input.query.startsWith("op:")) {
        if (!input.project)
          throw new AtmError("PROJECT_REQUIRED", { message: "op_id 精确回查要求 project" });
        const exactOpId = input.query.slice(3).trim();
        if (!exactOpId) throw new AtmError("VALIDATION_ERROR", { message: "op: 后必须提供 op_id" });
        const trace = compactOperationTrace(
          plain(await service.getOperationTrace(input.project, opId.parse(exactOpId))),
        );
        const source = selectFields(trace, input.field_mask);
        const fitted = fitFieldRead(
          source,
          Math.max(300, input.max_chars - 80),
          "atm_search",
          {
            project: input.project,
            entity: `${exactOpId}@*`,
            entityType: "OPERATION",
            fieldMask: input.field_mask,
            targetVersion: fieldTargetVersion(trace),
          },
          input.cursor,
        );
        return wrap({ exact: true, entity_type: "OPERATION", operation: fitted });
      }
      const scopedEntity = scopedUlidQuery(input.query);
      if (scopedEntity) {
        if (!input.project) {
          throw new AtmError("PROJECT_REQUIRED", {
            message: `${scopedEntity.kind.toLowerCase()} 精确读取要求 project`,
          });
        }
        const entity =
          scopedEntity.kind === "PROGRESS"
            ? compactProgress(
                plain(await service.getProgressUpdate(input.project, scopedEntity.id)),
              )
            : compactSession(plain(await service.getSession(input.project, scopedEntity.id)));
        const source = selectFields(entity, input.field_mask);
        const fitted = fitFieldRead(
          source,
          Math.max(300, input.max_chars - 80),
          "atm_search",
          {
            project: input.project,
            entity: scopedEntity.id,
            entityType: scopedEntity.kind,
            fieldMask: input.field_mask,
            targetVersion: fieldTargetVersion(entity),
          },
          input.cursor,
        );
        return wrap({ exact: true, entity_type: scopedEntity.kind, entity: fitted });
      }
      const kind = publicKeyKind(input.query);
      const exactProject = input.project ?? projectFromPublicKey(input.query) ?? undefined;
      if (kind && exactProject) {
        const entity = plain(
          kind === "WORK_ITEM"
            ? await service.getWorkItem(exactProject, input.query, "full")
            : compactRecord(plain(await service.getRecord(exactProject, input.query))),
        );
        const source = selectFields(entity, input.field_mask);
        const fitted = fitFieldRead(
          source,
          Math.max(300, input.max_chars - 80),
          "atm_search",
          {
            project: exactProject,
            entity: input.query.toUpperCase(),
            entityType: kind,
            fieldMask: input.field_mask,
            targetVersion: fieldTargetVersion(entity),
          },
          input.cursor,
        );
        return wrap({
          exact: true,
          entity_type: kind,
          entity: fitted,
        });
      }

      const searchQuery = input.query;
      const fetchPage = (limit: number) =>
        input.project
          ? service.search(input.project, searchQuery, limit, input.cursor)
          : service.globalSearch(searchQuery, limit, input.cursor);
      const initial = (await fetchPage(input.limit)) as SearchServicePage;
      return wrap(
        await fitSearchPage({
          initial,
          fetchPage,
          requestedLimit: input.limit,
          ...(input.cursor === undefined ? {} : { inputCursor: input.cursor }),
          fieldMask: input.field_mask,
          maxChars: input.max_chars,
        }),
      );
    },
  );

  defineTool(
    "memory",
    "atm_delta",
    {
      description: "读增量变化。",
      inputSchema: z
        .object({
          project: projectCode,
          since_seq: z.number().int().nonnegative(),
          limit: z.number().int().min(1).max(100).default(50),
          types: z.array(z.string()).max(50).default([]),
          max_chars: z.number().int().min(1000).max(50_000).default(12_000),
        })
        .strict(),
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (input) => {
      const delta = (await service.delta(
        input.project,
        input.since_seq,
        input.limit,
        input.types,
      )) as Record<string, unknown>;
      return wrap(fitDelta(input.project, input.since_seq, input.limit, input.max_chars, delta));
    },
  );
}

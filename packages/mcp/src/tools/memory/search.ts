import type { AyanamiTaskService } from "@ayanami-task/application";
import { AtmError } from "@ayanami-task/errors";
import { z } from "zod";
import {
  compactOperationTrace,
  compactProgress,
  compactRecord,
  compactSession,
  compactSessionPageItem,
  fitRecordPage,
  fitSessionPage,
  scopedUlidQuery,
} from "../../paging/entities.js";
import { fieldTargetVersion, fitFieldRead, selectFields } from "../../paging/field.js";
import {
  fitSearchPage,
  projectFromPublicKey,
  publicKeyKind,
  type SearchServicePage,
} from "../../paging/search.js";
import { plain, wrap } from "../../result.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { opId, outputSchema, projectCode, sessionId } from "../primitives.js";

const inputSchema = z
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
  });

export function createAtmSearchTool(
  service: AyanamiTaskService,
): ToolDefinition<typeof inputSchema> {
  return {
    profile: "memory",
    name: "atm_search",
    description: "搜索事实。",
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: async (input) => {
      const decoded = inputSchema.parse(input);
      if (decoded.list === "records") {
        const page = await service.recordPage(decoded.project!, {
          limit: decoded.limit,
          ...(decoded.cursor === undefined ? {} : { cursor: decoded.cursor }),
        });
        const listFieldMask =
          decoded.field_mask.length > 0
            ? decoded.field_mask
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
            decoded.project!,
            decoded.limit,
            decoded.max_chars,
            projectedItems,
            page.itemCursors,
            page.hasMore,
            page.nextCursor,
            page.retryCursor,
          ),
        );
      }
      if (decoded.list === "sessions") {
        const page = await service.agentPage(decoded.project!, {
          limit: decoded.limit,
          ...(decoded.cursor === undefined ? {} : { cursor: decoded.cursor }),
        });
        const listFieldMask =
          decoded.field_mask.length > 0
            ? decoded.field_mask
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
            decoded.project!,
            decoded.limit,
            decoded.max_chars,
            projectedItems,
            page.itemCursors,
            page.hasMore,
            page.nextCursor,
            page.retryCursor,
          ),
        );
      }
      if (decoded.op_id !== undefined) {
        if (!decoded.project) {
          throw new AtmError("PROJECT_REQUIRED", { message: "op_id 精确回查要求 project" });
        }
        const trace = compactOperationTrace(
          plain(await service.getOperationTrace(decoded.project, decoded.op_id, decoded.session)),
        );
        const source = selectFields(trace, decoded.field_mask);
        const fitted = fitFieldRead(
          source,
          Math.max(300, decoded.max_chars - 80),
          "atm_search",
          {
            project: decoded.project,
            entity: `${decoded.op_id}@${decoded.session ?? "*"}`,
            entityType: "OPERATION",
            fieldMask: decoded.field_mask,
            targetVersion: fieldTargetVersion(trace),
          },
          decoded.cursor,
        );
        return wrap({ exact: true, entity_type: "OPERATION", operation: fitted });
      }
      if (!decoded.query) {
        throw new AtmError("VALIDATION_ERROR", { message: "query 或 op_id 至少提供一个" });
      }
      if (decoded.query.startsWith("op:")) {
        if (!decoded.project) {
          throw new AtmError("PROJECT_REQUIRED", { message: "op_id 精确回查要求 project" });
        }
        const exactOpId = decoded.query.slice(3).trim();
        if (!exactOpId) {
          throw new AtmError("VALIDATION_ERROR", { message: "op: 后必须提供 op_id" });
        }
        const trace = compactOperationTrace(
          plain(await service.getOperationTrace(decoded.project, opId.parse(exactOpId))),
        );
        const source = selectFields(trace, decoded.field_mask);
        const fitted = fitFieldRead(
          source,
          Math.max(300, decoded.max_chars - 80),
          "atm_search",
          {
            project: decoded.project,
            entity: `${exactOpId}@*`,
            entityType: "OPERATION",
            fieldMask: decoded.field_mask,
            targetVersion: fieldTargetVersion(trace),
          },
          decoded.cursor,
        );
        return wrap({ exact: true, entity_type: "OPERATION", operation: fitted });
      }
      const scopedEntity = scopedUlidQuery(decoded.query);
      if (scopedEntity) {
        if (!decoded.project) {
          throw new AtmError("PROJECT_REQUIRED", {
            message: `${scopedEntity.kind.toLowerCase()} 精确读取要求 project`,
          });
        }
        const entity =
          scopedEntity.kind === "PROGRESS"
            ? compactProgress(
                plain(await service.getProgressUpdate(decoded.project, scopedEntity.id)),
              )
            : compactSession(plain(await service.getSession(decoded.project, scopedEntity.id)));
        const source = selectFields(entity, decoded.field_mask);
        const fitted = fitFieldRead(
          source,
          Math.max(300, decoded.max_chars - 80),
          "atm_search",
          {
            project: decoded.project,
            entity: scopedEntity.id,
            entityType: scopedEntity.kind,
            fieldMask: decoded.field_mask,
            targetVersion: fieldTargetVersion(entity),
          },
          decoded.cursor,
        );
        return wrap({ exact: true, entity_type: scopedEntity.kind, entity: fitted });
      }
      const kind = publicKeyKind(decoded.query);
      const exactProject = decoded.project ?? projectFromPublicKey(decoded.query) ?? undefined;
      if (kind && exactProject) {
        const entity = plain(
          kind === "WORK_ITEM"
            ? await service.getWorkItem(exactProject, decoded.query, "full")
            : compactRecord(plain(await service.getRecord(exactProject, decoded.query))),
        );
        const source = selectFields(entity, decoded.field_mask);
        const fitted = fitFieldRead(
          source,
          Math.max(300, decoded.max_chars - 80),
          "atm_search",
          {
            project: exactProject,
            entity: decoded.query.toUpperCase(),
            entityType: kind,
            fieldMask: decoded.field_mask,
            targetVersion: fieldTargetVersion(entity),
          },
          decoded.cursor,
        );
        return wrap({ exact: true, entity_type: kind, entity: fitted });
      }

      const searchQuery = decoded.query;
      const fetchPage = (limit: number) =>
        decoded.project
          ? service.search(decoded.project, searchQuery, limit, decoded.cursor)
          : service.globalSearch(searchQuery, limit, decoded.cursor);
      const initial = (await fetchPage(decoded.limit)) as SearchServicePage;
      return wrap(
        await fitSearchPage({
          initial,
          fetchPage,
          requestedLimit: decoded.limit,
          ...(decoded.cursor === undefined ? {} : { inputCursor: decoded.cursor }),
          fieldMask: decoded.field_mask,
          maxChars: decoded.max_chars,
        }),
      );
    },
  };
}

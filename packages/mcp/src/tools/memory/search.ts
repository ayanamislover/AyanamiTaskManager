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
import {
  fieldTargetVersion,
  fitFieldRead,
  fitIgnoredFields,
  ignoredFields,
  selectFields,
} from "../../paging/field.js";
import {
  compactSearchHit,
  fitSearchPage,
  projectFromPublicKey,
  publicKeyKind,
  type SearchServicePage,
} from "../../paging/search.js";
import { plain, wrap } from "../../result.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { opId, outputSchema, projectCode, sessionId } from "../primitives.js";
import { externalizeTaskView } from "../../paging/task.js";

function maskEcho(items: Record<string, unknown>[], mask: string[], maxChars: number) {
  const shape = Object.assign({}, ...items);
  return fitIgnoredFields(items.length ? ignoredFields(shape, mask) : [], maxChars);
}

function checkedPage(
  result: Record<string, unknown>,
  echo: Record<string, unknown>,
  maxChars: number,
) {
  const combined = { ...result, ...echo };
  if (JSON.stringify(combined).length > maxChars) {
    throw new AtmError("RESULT_TOO_LARGE", {
      message: "预算无法容纳搜索回执",
      details: { recovery: { action: "increase_max_chars", preserve_cursor: true } },
    });
  }
  return wrap(combined);
}

function maskedExact(
  value: Record<string, unknown>,
  decoded: { field_mask: string[]; max_chars: number; cursor?: string | undefined },
  target: Parameters<typeof fitFieldRead>[3],
  slot: "entity" | "operation",
) {
  const { echo } = fitIgnoredFields(ignoredFields(value, decoded.field_mask), decoded.max_chars);
  const envelope = { exact: true, entity_type: target.entityType };
  const overhead = JSON.stringify({ ...envelope, [slot]: {}, ...echo }).length - 2;
  const fitted = fitFieldRead(
    selectFields(value, decoded.field_mask),
    decoded.max_chars - overhead,
    "atm_search",
    target,
    decoded.cursor,
  );
  const result = { ...envelope, [slot]: fitted, ...echo };
  if (JSON.stringify(result).length > decoded.max_chars) {
    throw new AtmError("RESULT_TOO_LARGE", {
      message: "预算无法容纳字段回执",
      details: { recovery: { action: "increase_max_chars", preserve_cursor: true } },
    });
  }
  return wrap(result);
}

// 0 命中时告诉调用方下一步怎么查，而不是让它在同一条 query 上反复换写法。
function noMatchNextStep(query: string, project: string | undefined) {
  const suggestions = /\s/u.test(query)
    ? ["每个词都必须命中；删掉部分词，只留最有区分度的一两个（如 ID 片段 D-398）"]
    : ["换更短的片段或同义词；ID 可只写编号部分（如 D-398）"];
  suggestions.push("已知完整 key（如 ATM-R-12）时直接用它查，走精确读取");
  if (project !== undefined) suggestions.push("省略 project 可跨全部项目搜索");
  return { reason: "NO_MATCH", suggestions };
}

const inputSchema = z
  .object({
    list: z.enum(["records", "sessions"]).optional(),
    project: projectCode.optional(),
    query: z.string().trim().min(1).max(500).optional(),
    op_id: opId.optional(),
    session: sessionId.optional(),
    limit: z.number().int().min(1).max(30).default(20),
    cursor: z.string().optional(),
    field_mask: z.array(z.string().max(64)).max(20).default([]),
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
    description:
      "搜索事实。多个词须同时命中，双引号括起为相邻短语。session 只能与 op_id 精确回查一起传。",
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
        const externalItems = page.items.map((record) => compactRecord(plain(record)));
        const { echo, cost } = maskEcho(externalItems, decoded.field_mask, decoded.max_chars);
        const projectedItems = externalItems.map((record) => selectFields(record, listFieldMask));
        return checkedPage(
          fitRecordPage(
            decoded.project!,
            decoded.limit,
            decoded.max_chars - cost,
            projectedItems,
            page.itemCursors,
            page.hasMore,
            page.nextCursor,
            page.retryCursor,
          ),
          echo,
          decoded.max_chars,
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
        const externalItems = page.items.map((session) => compactSessionPageItem(plain(session)));
        const { echo, cost } = maskEcho(externalItems, decoded.field_mask, decoded.max_chars);
        const projectedItems = externalItems.map((session) => selectFields(session, listFieldMask));
        return checkedPage(
          fitSessionPage(
            decoded.project!,
            decoded.limit,
            decoded.max_chars - cost,
            projectedItems,
            page.itemCursors,
            page.hasMore,
            page.nextCursor,
            page.retryCursor,
          ),
          echo,
          decoded.max_chars,
        );
      }
      if (decoded.op_id !== undefined) {
        if (!decoded.project) {
          throw new AtmError("PROJECT_REQUIRED", { message: "op_id 精确回查要求 project" });
        }
        const trace = compactOperationTrace(
          plain(await service.getOperationTrace(decoded.project, decoded.op_id, decoded.session)),
        );
        return maskedExact(
          trace,
          decoded,
          {
            project: decoded.project,
            entity: `${decoded.op_id}@${decoded.session ?? "*"}`,
            entityType: "OPERATION",
            fieldMask: decoded.field_mask,
            targetVersion: fieldTargetVersion(trace),
          },
          "operation",
        );
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
        return maskedExact(
          trace,
          decoded,
          {
            project: decoded.project,
            entity: `${exactOpId}@*`,
            entityType: "OPERATION",
            fieldMask: decoded.field_mask,
            targetVersion: fieldTargetVersion(trace),
          },
          "operation",
        );
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
        return maskedExact(
          entity,
          decoded,
          {
            project: decoded.project,
            entity: scopedEntity.id,
            entityType: scopedEntity.kind,
            fieldMask: decoded.field_mask,
            targetVersion: fieldTargetVersion(entity),
          },
          "entity",
        );
      }
      const kind = publicKeyKind(decoded.query);
      const exactProject = decoded.project ?? projectFromPublicKey(decoded.query) ?? undefined;
      if (kind && exactProject) {
        const entity = plain(
          kind === "WORK_ITEM"
            ? externalizeTaskView(await service.getWorkItem(exactProject, decoded.query, "full"))
            : compactRecord(plain(await service.getRecord(exactProject, decoded.query))),
        );
        return maskedExact(
          entity,
          decoded,
          {
            project: exactProject,
            entity: decoded.query.toUpperCase(),
            entityType: kind,
            fieldMask: decoded.field_mask,
            targetVersion: fieldTargetVersion(entity),
          },
          "entity",
        );
      }

      const searchQuery = decoded.query;
      const fetchPage = (limit: number) =>
        decoded.project
          ? service.search(decoded.project, searchQuery, limit, decoded.cursor)
          : service.globalSearch(searchQuery, limit, decoded.cursor);
      const initial = (await fetchPage(decoded.limit)) as SearchServicePage;
      const { echo, cost } = maskEcho(
        initial.hits.map((hit) => compactSearchHit(plain(hit))),
        decoded.field_mask,
        decoded.max_chars,
      );
      const page = await fitSearchPage({
        initial,
        fetchPage,
        requestedLimit: decoded.limit,
        ...(decoded.cursor === undefined ? {} : { inputCursor: decoded.cursor }),
        fieldMask: decoded.field_mask,
        maxChars: decoded.max_chars - cost,
      });
      // 提示在 max_chars 下限 300 内放得下（有用例钉住），不必再为它单独降级。
      const hinted =
        initial.hits.length === 0 && decoded.cursor === undefined
          ? { ...page, next_step: noMatchNextStep(searchQuery, decoded.project) }
          : page;
      return checkedPage(hinted, echo, decoded.max_chars);
    },
  };
}

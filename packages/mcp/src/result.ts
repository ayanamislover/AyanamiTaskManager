import type { AyanamiTaskService } from "@ayanami-task/application";
import { AtmError, asAtmError } from "@ayanami-task/errors";
import { MUTATION_ACK_CONTRACT } from "./mutation-ack-contract.js";

export function plain(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  }
  return { value };
}

export function bounded(value: unknown, maxChars: number): Record<string, unknown> {
  const normalized = plain(value);
  if (JSON.stringify(normalized).length <= maxChars) return normalized;

  type TruncatedField = {
    path: string;
    original_chars: number;
    returned_chars: number;
  };
  type TruncatedCollection = {
    path: string;
    original_items: number;
    returned_items: number;
  };
  for (const [maxString, maxArray] of [
    [512, 20],
    [180, 10],
    [120, 8],
    [80, 5],
    [48, 3],
  ] as const) {
    const truncatedFields: TruncatedField[] = [];
    const truncatedCollections: TruncatedCollection[] = [];
    const shrink = (entry: unknown, path: string): unknown => {
      if (typeof entry === "string") {
        if (entry.length <= maxString) return entry;
        const returned = `${entry.slice(0, Math.max(0, maxString - 1))}…`;
        truncatedFields.push({
          path,
          original_chars: entry.length,
          returned_chars: returned.length,
        });
        return returned;
      }
      if (Array.isArray(entry)) {
        const returned = entry.slice(0, maxArray);
        if (returned.length < entry.length) {
          truncatedCollections.push({
            path,
            original_items: entry.length,
            returned_items: returned.length,
          });
        }
        return returned.map((child, index) => shrink(child, `${path}[${index}]`));
      }
      if (entry && typeof entry === "object") {
        return Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).map(([key, child]) => {
            const childPath = path ? `${path}.${key}` : key;
            return [key, shrink(child, childPath)];
          }),
        );
      }
      return entry;
    };
    const candidate = shrink(normalized, "") as Record<string, unknown>;
    const annotated: Record<string, unknown> = {
      ...candidate,
      truncated: true,
      ...(truncatedFields.length === 0 ? {} : { truncated_fields: truncatedFields }),
      ...(truncatedCollections.length === 0 ? {} : { truncated_collections: truncatedCollections }),
    };
    if (JSON.stringify(annotated).length <= maxChars) return annotated;
  }
  return {
    truncated: true,
    code: "RESULT_TOO_LARGE",
    hint: "使用该工具的 max_chars、cursor、field_mask、limit 或 include 缩小读取范围",
  };
}

export function wrap(structuredContent: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

export function mcpResult(value: unknown, maxChars = 4000) {
  return wrap(bounded(value, maxChars));
}

type MutationEntityReference = {
  entity_type: string;
  key: string;
  version: number | null;
};

export function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function uniqueMutationEntityReferences(
  references: MutationEntityReference[],
): MutationEntityReference[] {
  const unique = new Map<string, MutationEntityReference>();
  for (const reference of references) {
    const identity = `${reference.entity_type}\0${reference.key}`;
    const previous = unique.get(identity);
    if (!previous || (previous.version === null && reference.version !== null)) {
      unique.set(identity, reference);
    }
  }
  return [...unique.values()];
}

export function mutationEntityReferences(
  operation: string,
  serviceResult: Record<string, unknown>,
): MutationEntityReference[] {
  const references: MutationEntityReference[] = [];
  const add = (entityType: string, key: unknown, version: unknown = null) => {
    if (typeof key !== "string" || !key.trim()) return;
    references.push({
      entity_type: entityType,
      key,
      version: typeof version === "number" && Number.isSafeInteger(version) ? version : null,
    });
  };
  const addWorkItems = (items: unknown) => {
    if (!Array.isArray(items)) return;
    for (const value of items) {
      const item = objectValue(value);
      add("WORK_ITEM", item.key ?? item.taskKey, item.version ?? item.taskVersion);
    }
  };

  switch (operation) {
    case "work.create.batch":
    case "work.patch.batch":
      addWorkItems(serviceResult.items);
      break;
    case "work.verify-and-complete":
      add("WORK_ITEM", serviceResult.taskKey, serviceResult.taskVersion);
      break;
    case "review.request.create": {
      const request = objectValue(serviceResult.request);
      add("REVIEW_REQUEST", request.key);
      add("WORK_ITEM", request.reviewTaskKey);
      add("WORK_ITEM", request.parentTaskKey);
      add("CHECKLIST", request.parentChecklistId, request.parentChecklistVersion);
      break;
    }
    case "review.submit": {
      add("REVIEW_REQUEST", serviceResult.requestKey);
      add("REVIEW_SUBMISSION", serviceResult.submissionKey);
      add("RECORD", serviceResult.recordKey);
      const reviewTask = objectValue(serviceResult.reviewTask);
      const parentChecklist = objectValue(serviceResult.parentChecklist);
      const parentTask = objectValue(serviceResult.parentTask);
      add("WORK_ITEM", reviewTask.key, reviewTask.version);
      add("CHECKLIST", parentChecklist.id, parentChecklist.version);
      add("WORK_ITEM", parentTask.key, parentTask.version);
      break;
    }
    case "checklist.update": {
      const checklist = objectValue(serviceResult.checklist);
      add("WORK_ITEM", serviceResult.taskKey, serviceResult.taskVersion);
      add("CHECKLIST", checklist.id, checklist.version);
      break;
    }
    case "checklist.update.batch":
      add("WORK_ITEM", serviceResult.taskKey, serviceResult.taskVersion);
      if (Array.isArray(serviceResult.checklist)) {
        for (const value of serviceResult.checklist) {
          const checklist = objectValue(value);
          add("CHECKLIST", checklist.id, checklist.version);
        }
      }
      break;
    case "work.progress":
      add("WORK_ITEM", serviceResult.key, serviceResult.v);
      add("PROGRESS", serviceResult.progressId);
      break;
    case "project-update.publish":
      add("PROJECT_UPDATE", serviceResult.id, serviceResult.version);
      break;
    case "record.create":
      add("RECORD", serviceResult.key, serviceResult.v);
      break;
    case "session.end":
      add("SESSION", serviceResult.session, serviceResult.version);
      addWorkItems(serviceResult.releasedItems);
      break;
  }

  return uniqueMutationEntityReferences(references);
}

function mutationEntityPreview(entities: MutationEntityReference[]): MutationEntityReference[] {
  const preview: MutationEntityReference[] = [];
  let chars = 2;
  for (const entity of entities) {
    if (preview.length >= MUTATION_ACK_CONTRACT.entityPreview.maxItems) break;
    const entityChars = JSON.stringify(entity).length + (preview.length === 0 ? 0 : 1);
    if (chars + entityChars > MUTATION_ACK_CONTRACT.entityPreview.maxChars) break;
    preview.push(entity);
    chars += entityChars;
  }
  return preview;
}

export function projectionAcknowledgement(
  value: unknown,
  operationId: string,
): Record<string, unknown> {
  const projection = objectValue(value);
  const status = projection.status;
  const sourceSeq = projection.sourceSeq;
  const projectedSeq = projection.projectedSeq;
  const retryScheduled = projection.retryScheduled;
  const retryCount = projection.retryCount;
  const lastError = projection.lastError;
  if (
    (status !== "APPLIED" && status !== "DEFERRED") ||
    typeof sourceSeq !== "number" ||
    !Number.isSafeInteger(sourceSeq) ||
    sourceSeq < 0 ||
    typeof projectedSeq !== "number" ||
    !Number.isSafeInteger(projectedSeq) ||
    projectedSeq < 0 ||
    projectedSeq > sourceSeq ||
    typeof retryScheduled !== "boolean" ||
    typeof retryCount !== "number" ||
    !Number.isSafeInteger(retryCount) ||
    retryCount < 0 ||
    (status === "APPLIED" && projectedSeq !== sourceSeq) ||
    (lastError !== null && typeof lastError !== "string")
  ) {
    throw new AtmError("INTERNAL_ERROR", {
      message: "mutation acknowledgement 缺少有效的持久 projection receipt",
      details: { operation_id: operationId },
    });
  }
  return {
    status,
    source_seq: sourceSeq,
    projected_seq: projectedSeq,
    retry_scheduled: retryScheduled,
    last_error: lastError,
    retry_count: retryCount,
  };
}

export function mutationAck(
  project: string,
  requestedSession: string,
  opId: string,
  operation: string,
  serviceResult: Record<string, unknown>,
) {
  const projection = projectionAcknowledgement(serviceResult.projection, opId);
  const reboundSession =
    typeof serviceResult.newSession === "string"
      ? serviceResult.newSession
      : typeof serviceResult.session === "string"
        ? serviceResult.session
        : undefined;
  const session = serviceResult.sessionRebound === true ? reboundSession : requestedSession;
  if (session === undefined) {
    throw new AtmError("INTERNAL_ERROR", {
      message: "mutation acknowledgement 缺少 Session",
      details: { operation_id: opId },
    });
  }
  const entities = mutationEntityReferences(operation, serviceResult);
  const preview = mutationEntityPreview(entities);
  const normalizedProject = project.toUpperCase();
  return {
    ok: true,
    op_id: opId,
    project: normalizedProject,
    session,
    session_rebound: serviceResult.sessionRebound === true,
    projection,
    entities: preview,
    entity_count: entities.length,
    entities_truncated: preview.length < entities.length,
    details_cursor: {
      name: MUTATION_ACK_CONTRACT.detailsCursor.name,
      arguments: {
        project: normalizedProject,
        op_id: opId,
        session,
        field_mask: [...MUTATION_ACK_CONTRACT.detailsCursor.fieldMask],
        max_chars: MUTATION_ACK_CONTRACT.detailsCursor.maxChars,
      },
    },
  };
}

type McpErrorContext = {
  project?: string;
};

export async function withMcpErrorDetails<T>(
  service: AyanamiTaskService,
  context: McpErrorContext,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const base = asAtmError(error);
    if (typeof service.enrichError !== "function") throw base;
    let enriched: AtmError;
    try {
      enriched = await service.enrichError(base, {
        ...(context.project === undefined ? {} : { projectCode: context.project }),
      });
    } catch {
      throw base;
    }
    throw enriched;
  }
}

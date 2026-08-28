import { AtmError } from "@ayanami-task/errors";
import { projectionAcknowledgement } from "../result.js";
import { MCP_SURFACE_VERSION } from "../surface.js";
import {
  briefAlwaysKeys,
  briefDropOrder,
  briefSections,
  encodeBriefCursor,
  makeBriefCursor,
  pickBriefSections,
  type BriefCursor,
  type BriefRecordSnapshot,
  type BriefSection,
} from "./brief-cursor.js";

type BriefFitInput = {
  payload: Record<string, unknown>;
  include: readonly BriefSection[];
  maxChars: number;
  identity?: Record<string, unknown>;
  project: string;
  sessionId?: string;
  taskKey?: string;
  sinceSeq?: number;
  beginMode?: BeginBriefMode;
  recordSnapshot?: BriefRecordSnapshot[];
};

function briefCandidate(input: {
  source: Record<string, unknown>;
  identity: Record<string, unknown>;
  dropped: readonly BriefSection[];
  omittedFields: readonly { section: BriefSection; fields: readonly string[] }[];
  recordCount: number;
  totalRecords: number;
  cursor?: string;
  beginMode?: BeginBriefMode;
}): Record<string, unknown> {
  const droppedKeys = new Set<string>(
    input.dropped.flatMap((section) => [...briefSections[section]]),
  );
  const body = Object.fromEntries(
    Object.entries(input.source)
      .filter(
        ([key]) =>
          !briefAlwaysKeys.includes(key) &&
          !droppedKeys.has(key) &&
          !(key in input.identity) &&
          key !== "score",
      )
      .map(([key, value]) =>
        key === "records" && Array.isArray(value)
          ? [key, value.slice(0, input.recordCount)]
          : [key, value],
      ),
  );
  const omittedRecords = input.recordCount < input.totalRecords;
  const truncated =
    input.dropped.length > 0 ||
    input.omittedFields.length > 0 ||
    omittedRecords ||
    input.source.truncated === true;
  return {
    ...input.identity,
    project: input.source.project,
    seq: input.source.seq,
    ...body,
    truncated,
    ...(input.beginMode === undefined
      ? {}
      : { brief_mode: input.beginMode, brief_truncated: truncated }),
    ...(input.dropped.length === 0 ? {} : { omitted_sections: input.dropped }),
    ...(input.omittedFields.length === 0 ? {} : { omitted_fields: input.omittedFields }),
    ...(omittedRecords
      ? {
          omitted_collections: [
            {
              section: "records",
              total_items: input.totalRecords,
              returned_items: input.recordCount,
              omitted_items: input.totalRecords - input.recordCount,
            },
          ],
          ...(input.cursor === undefined
            ? { continuation_omitted: true }
            : { continuation: { tool: "atm_brief", cursor: input.cursor } }),
        }
      : {}),
  };
}

// brief 不对 Record 或其他分节内部做字符串截断。预算不足时先按分节价值丢弃，
// records 则仅在整条边界分页。这样恢复上下文的 Agent 要么读到完整事实，要么收到
// 可续读的省略回执，不会再把半句话当成全部事实。
export function fitWholeBrief(input: BriefFitInput): Record<string, unknown> {
  const frozenSource = pickBriefSections(input.payload, input.include);
  let source = frozenSource;
  const records = Array.isArray(frozenSource.records) ? frozenSource.records : [];
  const recordSnapshot = input.recordSnapshot ?? [];
  const snapshotSeq =
    typeof frozenSource.seq === "number" && Number.isSafeInteger(frozenSource.seq)
      ? frozenSource.seq
      : 0;
  if (records.length !== recordSnapshot.length && records.length > 0) {
    throw new AtmError("INVALID_RESPONSE", {
      message: "brief Record snapshot 与返回集合不一致",
      details: { records: records.length, versions: recordSnapshot.length },
    });
  }
  let recordCount = records.length;
  const dropped: BriefSection[] = [];
  const omittedFields: Array<{ section: BriefSection; fields: readonly string[] }> = [];
  const actions = briefDropOrder.filter((section) =>
    briefSections[section].some((key) => key in source),
  );
  const identity = input.identity ?? {};

  for (;;) {
    const cursor =
      recordCount < records.length
        ? makeBriefCursor({
            project: input.project,
            ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
            include: input.include,
            ...(input.taskKey === undefined ? {} : { taskKey: input.taskKey }),
            ...(input.sinceSeq === undefined ? {} : { sinceSeq: input.sinceSeq }),
            offset: recordCount,
            recordSnapshot,
            snapshotSeq,
          })
        : undefined;
    const candidate = briefCandidate({
      source,
      identity,
      dropped,
      omittedFields,
      recordCount,
      totalRecords: records.length,
      ...(cursor === undefined ? {} : { cursor }),
      ...(input.beginMode === undefined ? {} : { beginMode: input.beginMode }),
    });
    if (JSON.stringify(candidate).length <= input.maxChars) return candidate;

    const victim = actions.shift();
    if (victim !== undefined) {
      if (victim === "records") {
        if (recordCount > 0) {
          recordCount -= 1;
          actions.unshift("records");
        }
        continue;
      }
      if (victim === "task" && source.task && typeof source.task === "object") {
        const task = source.task as Record<string, unknown>;
        const essentialKeys = [
          "key",
          "title",
          "type",
          "status",
          "priority",
          "progress",
          "version",
          "blockedReason",
          "waitingFor",
          "dependencies",
        ];
        const compact = Object.fromEntries(
          essentialKeys.filter((key) => task[key] !== undefined).map((key) => [key, task[key]]),
        );
        const omitted = Object.keys(task).filter((key) => !(key in compact));
        if (omitted.length > 0) {
          source = { ...source, task: compact };
          omittedFields.push({ section: "task", fields: omitted });
          actions.unshift("task");
          continue;
        }
      }
      dropped.push(victim);
      continue;
    }
    if (recordCount > 0) {
      recordCount -= 1;
      continue;
    }

    // 极窄预算可能连带 continuation cursor 都放不下。身份回执仍逐字保留，不伪造一个
    // 超预算或无法校验的 cursor；调用方可以扩大预算后重新发起首页。
    return briefCandidate({
      source,
      identity,
      dropped,
      omittedFields,
      recordCount: 0,
      totalRecords: records.length,
      ...(input.beginMode === undefined ? {} : { beginMode: input.beginMode }),
    });
  }
}

export function continueWholeBrief(
  cursor: BriefCursor,
  input: Omit<BriefFitInput, "identity" | "beginMode">,
  records: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const source = pickBriefSections(input.payload, input.include);
  let returned = records.length - cursor.o;
  const currentSeq =
    typeof source.seq === "number" && Number.isSafeInteger(source.seq) ? source.seq : cursor.n;
  for (;;) {
    const nextOffset = cursor.o + returned;
    const nextCursor =
      nextOffset < records.length ? encodeBriefCursor({ ...cursor, o: nextOffset }) : undefined;
    const candidate: Record<string, unknown> = {
      project: source.project,
      seq: source.seq,
      ...(input.sessionId === undefined ? {} : { session_id: input.sessionId }),
      records: records.slice(cursor.o, nextOffset),
      offset: cursor.o,
      returned_items: returned,
      total_items: records.length,
      truncated: nextCursor !== undefined,
      ...(currentSeq > cursor.n
        ? { snapshot_advanced_from: cursor.n, snapshot_advanced_to: currentSeq }
        : {}),
      ...(nextCursor === undefined
        ? {}
        : { continuation: { tool: "atm_brief", cursor: nextCursor } }),
    };
    if (JSON.stringify(candidate).length <= input.maxChars) return candidate;
    if (returned > 0) {
      returned -= 1;
      continue;
    }
    throw new AtmError("RESULT_TOO_LARGE", {
      message: `max_chars=${input.maxChars} 无法容纳一条完整 Record continuation`,
      details: {
        max_chars: input.maxChars,
        recovery: { action: "increase_max_chars", preserve_cursor: true },
      },
    });
  }
}

export type BeginBriefMode = "none" | "minimal" | "full";

/**
 * `atm_begin` 先在服务端创建 Session，再附带工作摘要。摘要是可降级载荷，Session 身份不是。
 * 通用 bounded() 会递归截断所有字符串，最坏时还会把整个对象换成 RESULT_TOO_LARGE；用于
 * begin 就可能把已经提交的 session/operationId 一并丢掉。这里把不可截断的回执外壳和可裁剪
 * brief 分开计算预算，任何规模下都先保住调用方继续使用 ATM 所必需的门牌号。
 */
export function fitBegin(
  payload: Record<string, unknown>,
  mode: BeginBriefMode,
  maxChars: number,
  recordSnapshot: BriefRecordSnapshot[],
): Record<string, unknown> {
  const atomicOperationId =
    payload.atomicBegin && typeof payload.atomicBegin === "object"
      ? (payload.atomicBegin as Record<string, unknown>).operationId
      : undefined;
  const projection =
    payload.projection === undefined
      ? undefined
      : projectionAcknowledgement(payload.projection, String(atomicOperationId ?? "atm_begin"));
  const identity: Record<string, unknown> = {
    scope: payload.scope,
    session: payload.session,
    project: payload.project,
    surface_version: MCP_SURFACE_VERSION,
    ...(typeof atomicOperationId === "string" ? { op_id: atomicOperationId } : {}),
    ...(payload.atomicBegin === undefined ? {} : { atomicBegin: payload.atomicBegin }),
    ...(projection === undefined ? {} : { projection }),
  };
  if (mode === "none") return { ...identity, brief_mode: mode, brief_truncated: false };

  const selected =
    mode === "minimal"
      ? pickBriefSections(payload, ["counts", "next", "current", "handoff"])
      : payload;
  return fitWholeBrief({
    payload: selected,
    include: [],
    maxChars,
    identity,
    project: String(payload.project),
    ...(typeof payload.session === "string" ? { sessionId: payload.session } : {}),
    beginMode: mode,
    recordSnapshot,
  });
}

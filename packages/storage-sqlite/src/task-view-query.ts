import type { TaskViewName } from "@ayanami-task/protocol";

export type TaskViewProjectionRow = {
  localNo: number;
  priorityRank: number;
  sortKey: number;
  createdAt: string;
  status: string;
  phase: string;
  waitingOn: string | null;
  progress: number;
  progressSource: string;
  version: number;
  updatedAt: string;
  title?: string;
  description?: string;
  acceptanceJson?: string;
  assigneeAgentId?: string | null;
  waitingFor?: string | null;
  blockedReason?: string | null;
  checklistTotal?: number;
  checklistTodo?: number;
  checklistDoing?: number;
  checklistDone?: number;
  checklistSkipped?: number;
  checklistEvidenceRequired?: number;
  checklistEvidenceMissing?: number;
  checklistJson?: string;
  relationsJson?: string;
};

/**
 * Builds the one-statement read projection used by both task list and task get.
 * The selected CTE bounds every aggregate to the requested page, so context/full
 * costs stay proportional to the page without issuing a query per WorkItem.
 */
export function taskViewProjectionSql(input: {
  whereSql: string;
  selectionTailSql: string;
  view: TaskViewName;
}): string {
  const withContext = input.view !== "core";
  const withFull = input.view === "full";
  const contextCtes = withContext
    ? `,
       checklist_summary AS (
         SELECT checklist.work_item_id,
                COUNT(*) AS total,
                SUM(CASE WHEN checklist.status = 'TODO' THEN 1 ELSE 0 END) AS todo,
                SUM(CASE WHEN checklist.status = 'DOING' THEN 1 ELSE 0 END) AS doing,
                SUM(CASE WHEN checklist.status = 'DONE' THEN 1 ELSE 0 END) AS done,
                SUM(CASE WHEN checklist.status = 'SKIPPED' THEN 1 ELSE 0 END) AS skipped,
                SUM(CASE WHEN checklist.evidence_required = 1 THEN 1 ELSE 0 END) AS evidence_required,
                SUM(CASE WHEN checklist.evidence_required = 1
                              AND checklist.status <> 'SKIPPED'
                              AND COALESCE(json_array_length(checklist.evidence_json), 0) = 0
                         THEN 1 ELSE 0 END) AS evidence_missing
         FROM checklist_items checklist
         JOIN selected ON selected.id = checklist.work_item_id
         GROUP BY checklist.work_item_id
       )`
    : "";
  const fullCtes = withFull
    ? `,
       checklist_window AS (
         SELECT checklist.work_item_id,
                json_group_array(json_object(
                  'id', checklist.id,
                  'title', checklist.title,
                  'kind', checklist.kind,
                  'status', checklist.status,
                  'weight', checklist.weight,
                  'evidenceRequired', CASE checklist.evidence_required WHEN 1 THEN json('true') ELSE json('false') END,
                  'evidence', json(checklist.evidence_json),
                  'version', checklist.version
                )) OVER (
                  PARTITION BY checklist.work_item_id
                  ORDER BY checklist.created_at, checklist.rowid
                  ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
                ) AS checklist_json,
                row_number() OVER (
                  PARTITION BY checklist.work_item_id
                  ORDER BY checklist.created_at DESC, checklist.rowid DESC
                ) AS final_row
         FROM checklist_items checklist
         JOIN selected ON selected.id = checklist.work_item_id
       ),
       checklist_projection AS (
         SELECT work_item_id, checklist_json
         FROM checklist_window
         WHERE final_row = 1
       ),
       relation_edges AS (
         SELECT child.id AS work_item_id, 'PARENT' AS relation_type,
                'OUTGOING' AS direction, parent.local_no AS related_local_no
         FROM selected child
         JOIN work_items parent ON parent.id = child.parent_id
         UNION ALL
         SELECT parent.id AS work_item_id, 'CHILD' AS relation_type,
                'INCOMING' AS direction, child.local_no AS related_local_no
         FROM selected parent
         JOIN work_items child ON child.parent_id = parent.id AND child.archived_at IS NULL
         UNION ALL
         SELECT source.id AS work_item_id, relation.relation_type,
                'OUTGOING' AS direction, target.local_no AS related_local_no
         FROM selected source
         JOIN work_item_relations relation ON relation.source_id = source.id
         JOIN work_items target ON target.id = relation.target_id
         UNION ALL
         SELECT target.id AS work_item_id, relation.relation_type,
                'INCOMING' AS direction, source.local_no AS related_local_no
         FROM selected target
         JOIN work_item_relations relation ON relation.target_id = target.id
         JOIN work_items source ON source.id = relation.source_id
       ),
       relation_projection AS (
         SELECT work_item_id,
                json_group_array(json_object(
                  'type', relation_type,
                  'direction', direction,
                  'localNo', related_local_no
                )) AS relations_json
         FROM relation_edges
         GROUP BY work_item_id
       )`
    : "";
  const contextColumns = withContext
    ? `,
       selected.title AS title,
       selected.description AS description,
       selected.acceptance_json AS acceptanceJson,
       selected.assignee_agent_id AS assigneeAgentId,
       selected.waiting_for AS waitingFor,
       selected.blocked_reason AS blockedReason,
       COALESCE(checklist_summary.total, 0) AS checklistTotal,
       COALESCE(checklist_summary.todo, 0) AS checklistTodo,
       COALESCE(checklist_summary.doing, 0) AS checklistDoing,
       COALESCE(checklist_summary.done, 0) AS checklistDone,
       COALESCE(checklist_summary.skipped, 0) AS checklistSkipped,
       COALESCE(checklist_summary.evidence_required, 0) AS checklistEvidenceRequired,
       COALESCE(checklist_summary.evidence_missing, 0) AS checklistEvidenceMissing`
    : "";
  const fullColumns = withFull
    ? `,
       COALESCE(checklist_projection.checklist_json, '[]') AS checklistJson,
       COALESCE(relation_projection.relations_json, '[]') AS relationsJson`
    : "";
  const contextJoins = withContext
    ? "LEFT JOIN checklist_summary ON checklist_summary.work_item_id = selected.id"
    : "";
  const fullJoins = withFull
    ? `LEFT JOIN checklist_projection ON checklist_projection.work_item_id = selected.id
       LEFT JOIN relation_projection ON relation_projection.work_item_id = selected.id`
    : "";

  return `WITH selected AS (
            SELECT work_items.*
            FROM work_items
            WHERE ${input.whereSql}
            ${input.selectionTailSql}
          )
          ${contextCtes}
          ${fullCtes}
          SELECT selected.local_no AS localNo,
                 CASE selected.priority
                   WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1
                   WHEN 'NORMAL' THEN 2 ELSE 3 END AS priorityRank,
                 selected.sort_key AS sortKey,
                 selected.created_at AS createdAt,
                 selected.status AS status,
                 selected.phase AS phase,
                 selected.waiting_on AS waitingOn,
                 selected.computed_progress AS progress,
                 selected.progress_source AS progressSource,
                 selected.version AS version,
                 selected.updated_at AS updatedAt
                 ${contextColumns}
                 ${fullColumns}
          FROM selected
          ${contextJoins}
          ${fullJoins}
          ORDER BY CASE selected.priority
                     WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1
                     WHEN 'NORMAL' THEN 2 ELSE 3 END,
                   selected.sort_key, selected.created_at, selected.local_no`;
}

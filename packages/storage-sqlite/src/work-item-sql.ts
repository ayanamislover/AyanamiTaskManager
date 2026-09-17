/**
 * work_items 读模型共用的 SQL 片段。
 *
 * 一次查询要同时带出清单、阻塞、发现关系和进度，拼接逻辑长且只有 SQLite 语义，
 * 单独成模块让读模型本身保持在可读的长度上。
 */

/** 已结束＝完成或取消。 */
export const CLOSED_STATUS_SQL = "status IN ('DONE', 'CANCELLED')";

/** 结束时间：取消的任务没有 completed_at，用最后更新时间代替。 */
export const FINISHED_AT_SQL = "COALESCE(completed_at, updated_at)";

export function hydratedWorkItemSql(
  whereSql: string,
  selectionTailSql: string,
  resultOrderSql: string,
): string {
  return `WITH selected AS (
            SELECT work_items.*
            FROM work_items
            WHERE ${whereSql}
            ${selectionTailSql}
          ), child_summary AS (
            SELECT child.parent_id AS work_item_id,
                   COALESCE(SUM(CASE WHEN child.status = 'DONE' THEN child.weight ELSE 0 END), 0) AS done_weight,
                   COALESCE(SUM(child.weight), 0) AS total_weight,
                   SUM(CASE WHEN child.status = 'DONE' THEN 1 ELSE 0 END) AS done_stages,
                   COUNT(*) AS total_stages
            FROM work_items child
            JOIN selected ON selected.id = child.parent_id
            WHERE child.archived_at IS NULL AND child.status <> 'CANCELLED'
            GROUP BY child.parent_id
          ), checklist_summary AS (
            SELECT checklist.work_item_id,
                   COALESCE(SUM(CASE WHEN checklist.status = 'DONE' THEN checklist.weight ELSE 0 END), 0) AS done_weight,
                   COALESCE(SUM(checklist.weight), 0) AS total_weight,
                   SUM(CASE WHEN checklist.status = 'DONE' THEN 1 ELSE 0 END) AS done_stages,
                   COUNT(*) AS total_stages
            FROM checklist_items checklist
            JOIN selected ON selected.id = checklist.work_item_id
            WHERE checklist.status <> 'SKIPPED'
            GROUP BY checklist.work_item_id
          ), blocker_ranked AS (
            SELECT blocker.work_item_id,
                   COALESCE(NULLIF(blocker.detail, ''), NULLIF(blocker.waiting_for, ''), blocker.title) AS reason,
                    row_number() OVER (
                      PARTITION BY blocker.work_item_id
                      ORDER BY blocker.created_at DESC
                   ) AS blocker_rank
            FROM blockers blocker
            JOIN selected ON selected.id = blocker.work_item_id
            WHERE blocker.status = 'ACTIVE'
          ), discovered_from_ranked AS (
            SELECT relation.source_id AS work_item_id, target.local_no,
                   row_number() OVER (
                      PARTITION BY relation.source_id
                   ) AS relation_rank
            FROM work_item_relations relation
            JOIN selected ON selected.id = relation.source_id
            JOIN work_items target ON target.id = relation.target_id
            WHERE relation.relation_type = 'DISCOVERED_FROM'
          ), discovered_counts AS (
            SELECT relation.target_id AS work_item_id, COUNT(*) AS discovered_count
            FROM work_item_relations relation
            JOIN selected ON selected.id = relation.target_id
            WHERE relation.relation_type = 'DISCOVERED_FROM'
            GROUP BY relation.target_id
          )
          SELECT selected.*,
                 parent.local_no AS parent_local_no,
                 duplicate.local_no AS duplicate_of_local_no,
                 superseded.local_no AS superseded_by_local_no,
                 discovered_from.local_no AS discovered_from_local_no,
                 COALESCE(discovered_counts.discovered_count, 0) AS discovered_count,
                 COALESCE(child_summary.done_weight, 0) AS child_done_weight,
                 COALESCE(child_summary.total_weight, 0) AS child_total_weight,
                 COALESCE(child_summary.done_stages, 0) AS child_done_stages,
                 COALESCE(child_summary.total_stages, 0) AS child_total_stages,
                 COALESCE(checklist_summary.done_weight, 0) AS checklist_done_weight,
                 COALESCE(checklist_summary.total_weight, 0) AS checklist_total_weight,
                 COALESCE(checklist_summary.done_stages, 0) AS checklist_done_stages,
                 COALESCE(checklist_summary.total_stages, 0) AS checklist_total_stages,
                 blocker.reason AS active_blocker_reason
          FROM selected
          LEFT JOIN work_items parent ON parent.id = selected.parent_id
          LEFT JOIN work_items duplicate ON duplicate.id = selected.duplicate_of_id
          LEFT JOIN work_items superseded ON superseded.id = selected.superseded_by_id
          LEFT JOIN child_summary ON child_summary.work_item_id = selected.id
          LEFT JOIN checklist_summary ON checklist_summary.work_item_id = selected.id
          LEFT JOIN blocker_ranked blocker
            ON blocker.work_item_id = selected.id AND blocker.blocker_rank = 1
          LEFT JOIN discovered_from_ranked discovered_from
            ON discovered_from.work_item_id = selected.id AND discovered_from.relation_rank = 1
          LEFT JOIN discovered_counts ON discovered_counts.work_item_id = selected.id
          ${resultOrderSql}`;
}

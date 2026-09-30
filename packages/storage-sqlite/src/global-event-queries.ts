/**
 * 总览读全局事件用的几条查询（ATM-T-0536）。
 *
 * 「最近变化」分业务、系统两个窗口取，备份健康单独取最近一次备份的结果。系统事件和
 * 备份事件在很多库里都很稀少，没有索引时要把整张 global_events 从新到旧扫一遍才凑得够
 * 或确认没有——实测让服务空闲内存多出约 5MB。registry 迁移 0008 为这两类建了部分索引。
 *
 * 部分索引只有在查询条件和索引条件结构一致时才会被用上，所以条件写在这里一处，
 * 迁移照抄同一段；global-event-queries 的用例用 EXPLAIN QUERY PLAN 盯着它们确实走索引。
 */

/** 与界面 isSystemTimelineEvent 一致的系统事件判定；迁移 0008 的部分索引照抄这一段。 */
export const SYSTEM_EVENT_SQL = `(COALESCE(actor, 'SYSTEM') = 'SYSTEM' OR type LIKE 'backup.%'
      OR type IN ('project.creating', 'agent.git_context.updated', 'database.recovered'))`;

const EVENT_COLUMNS = "sequence, type, aggregate_id, actor, payload_json, created_at";

export function recentEventWindowSql(kind: "business" | "system", limit: number): string {
  const predicate = kind === "system" ? SYSTEM_EVENT_SQL : `NOT ${SYSTEM_EVENT_SQL}`;
  return `SELECT ${EVENT_COLUMNS}
           FROM global_events
           WHERE type <> 'project.summary.updated' AND ${predicate}
           ORDER BY sequence DESC LIMIT ${limit}`;
}

export const LAST_BACKUP_OUTCOME_SQL = `SELECT ${EVENT_COLUMNS}
         FROM global_events
         WHERE type IN ('backup.created', 'backup.failed')
         ORDER BY sequence DESC LIMIT 1`;

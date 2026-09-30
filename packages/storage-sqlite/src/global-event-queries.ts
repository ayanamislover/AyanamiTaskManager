/**
 * 总览读全局事件用的几条查询（ATM-T-0536）。
 *
 * 「最近变化」分业务、系统两个窗口取，备份健康单独取最近一次备份的结果。哪一类都可能
 * 在某个库里很稀少：系统事件少的库、没有备份的库、几乎全是 Git 上下文刷新的库。没有索引时
 * LIMIT 管不住扫描量，要把整张 global_events 从新到旧扫一遍才凑得够或确认没有——实测让服务
 * 空闲内存多出约 5MB，系统事件占多数的百万级库里总览要几百毫秒。registry 迁移 0008 为三类
 * 各建了一个部分索引。
 *
 * 部分索引只有在查询条件包含索引条件（结构一致）时才会被用上，所以条件写在这里一处，
 * 迁移照抄同一段；global-event-queries 的用例用 EXPLAIN QUERY PLAN 盯着它们确实走索引。
 * 0008 发布后就不能再改：要改条件，新增一个迁移重建索引，同时改这里和用例。
 *
 * 不用 LIKE：连接上设过 case_sensitive_like 时，含 LIKE 的部分索引建不起来；substr 是确定性
 * 函数，而且区分大小写，和界面 isSystemTimelineEvent 的 startsWith 一致。
 */

/** 总览和全局时间线都不显示的事件。 */
export const VISIBLE_EVENT_SQL = "type <> 'project.summary.updated'";

/** 与界面 isSystemTimelineEvent 一致的系统事件判定；迁移 0008 的部分索引照抄这一段。 */
export const SYSTEM_EVENT_SQL = `(COALESCE(actor, 'SYSTEM') = 'SYSTEM' OR substr(type, 1, 7) = 'backup.'
      OR type IN ('project.creating', 'agent.git_context.updated', 'database.recovered'))`;

const EVENT_COLUMNS = "sequence, type, aggregate_id, actor, payload_json, created_at";

export function recentEventWindowSql(kind: "business" | "system", limit: number): string {
  const predicate = kind === "system" ? SYSTEM_EVENT_SQL : `NOT ${SYSTEM_EVENT_SQL}`;
  return `SELECT ${EVENT_COLUMNS}
           FROM global_events
           WHERE ${VISIBLE_EVENT_SQL} AND ${predicate}
           ORDER BY sequence DESC LIMIT ${limit}`;
}

export const LAST_BACKUP_OUTCOME_SQL = `SELECT ${EVENT_COLUMNS}
         FROM global_events
         WHERE type IN ('backup.created', 'backup.failed')
         ORDER BY sequence DESC LIMIT 1`;

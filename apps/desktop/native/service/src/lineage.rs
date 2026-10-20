//! session lineage（10 R3；R9 N-05）。
//!
//! lineage 是只沿 predecessor 边连成的连通分量（前序、后继、兄弟后继都算），
//! 只连 agent_id 相同、role 相同的 session；后继的创建时间早于前序的旧边视为无效（可以断开环）。
//! 不走 parent_session。领取归属（R1、R2）与幂等查找（R3′）都按它判定。

use atm_domain::time::Timestamp;
use rusqlite::{OptionalExtension, Transaction};
use std::collections::{BTreeSet, HashMap};

/// `session` 所在 lineage 的全部 session id（含自己），按 id 排序。session 不存在时为空。
pub fn lineage(
    tx: &Transaction<'_>,
    project_id: &str,
    session: &str,
) -> rusqlite::Result<Vec<String>> {
    let Some((agent, role)): Option<(String, String)> = tx
        .query_row(
            "SELECT agent_id, role FROM agent_sessions WHERE project_id = ?1 AND id = ?2",
            [project_id, session],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
    else {
        return Ok(Vec::new());
    };
    let rows: Vec<(String, Option<String>, String)> = tx
        .prepare(
            "SELECT id, predecessor_session_id, started_at FROM agent_sessions
             WHERE project_id = ?1 AND agent_id = ?2 AND role = ?3",
        )?
        .query_map([project_id, &agent, &role], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let started: HashMap<&str, &str> = rows
        .iter()
        .map(|(id, _, at)| (id.as_str(), at.as_str()))
        .collect();
    let mut edges: HashMap<&str, Vec<&str>> = HashMap::new();
    for (id, pred, at) in &rows {
        let Some(pred) = pred.as_deref() else {
            continue;
        };
        let Some(pred_at) = started.get(pred) else {
            continue;
        }; // 跨 agent / role 的旧边不在集合里
        if !not_before(at, pred_at) {
            continue; // 时间倒序的旧边（N-05）
        }
        edges.entry(id).or_default().push(pred);
        edges.entry(pred).or_default().push(id);
    }
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    let mut stack = vec![session];
    while let Some(s) = stack.pop() {
        if !seen.insert(s) {
            continue;
        }
        if let Some(next) = edges.get(s) {
            stack.extend(next.iter().copied());
        }
    }
    Ok(seen.into_iter().map(str::to_owned).collect())
}

/// `a` 不早于 `b`。两边都能按 ISO 时间解析时比时间，否则退回字符串比较（同为 toISOString 输出时二者一致）。
fn not_before(a: &str, b: &str) -> bool {
    match (Timestamp::parse(a), Timestamp::parse(b)) {
        (Some(x), Some(y)) => x >= y,
        _ => a >= b,
    }
}

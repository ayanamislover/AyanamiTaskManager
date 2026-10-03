//! session lineage（10 R3；R9 N-05）。

use atm_service::lineage::lineage;
use rusqlite::params;
use std::path::PathBuf;

const T0: &str = "2026-10-03T00:00:00.000Z";
const T1: &str = "2026-10-03T01:00:00.000Z";
const T2: &str = "2026-10-03T02:00:00.000Z";

/// `(id, agent, role, predecessor, started_at)`
fn graph(name: &str, sessions: &[(&str, &str, &str, Option<&str>, &str)]) -> rusqlite::Connection {
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("target")
        });
    let dir = target.join("service-tests").join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut c = atm_store::open(&dir.join("atm.sqlite")).unwrap();
    // 只看 agent_sessions：项目行与外键与 lineage 无关。
    c.execute_batch("PRAGMA foreign_keys = OFF").unwrap();
    let tx = c.transaction().unwrap();
    for agent in ["claude", "codex"] {
        tx.execute(
            "INSERT INTO agents (project_id, id, display_name, client_kind, created_at, updated_at) VALUES ('P', ?1, ?1, 'cli', ?2, ?2)",
            params![agent, T0],
        )
        .unwrap();
    }
    for (id, agent, role, pred, at) in sessions {
        tx.execute(
            "INSERT INTO agent_sessions (project_id, id, agent_id, role, work_state, connection_state, started_at, updated_at, predecessor_session_id)
             VALUES ('P', ?1, ?2, ?3, 'IDLE', 'ONLINE', ?4, ?4, ?5)",
            params![id, agent, role, at, pred],
        )
        .unwrap();
    }
    tx.commit().unwrap();
    c
}

fn of(c: &mut rusqlite::Connection, s: &str) -> Vec<String> {
    let tx = c.transaction().unwrap();
    lineage(&tx, "P", s).unwrap()
}

#[test]
fn predecessors_successors_and_siblings_are_one_lineage() {
    let mut c = graph(
        "lineage-component",
        &[
            ("A", "claude", "PRIMARY", None, T0),
            ("B", "claude", "PRIMARY", Some("A"), T1),
            ("C", "claude", "PRIMARY", Some("A"), T1),
            ("D", "claude", "PRIMARY", Some("C"), T2),
        ],
    );
    for s in ["A", "B", "C", "D"] {
        assert_eq!(of(&mut c, s), ["A", "B", "C", "D"], "{s}");
    }
    assert!(of(&mut c, "NOPE").is_empty());
}

#[test]
fn edges_across_agents_or_roles_are_ignored() {
    let mut c = graph(
        "lineage-cross",
        &[
            ("A", "claude", "PRIMARY", None, T0),
            ("R", "claude", "REVIEWER", Some("A"), T1),
            ("X", "codex", "PRIMARY", Some("A"), T1),
        ],
    );
    assert_eq!(of(&mut c, "A"), ["A"]);
    assert_eq!(of(&mut c, "R"), ["R"]);
    assert_eq!(of(&mut c, "X"), ["X"]);
}

/// 后继比前序先开始的旧边无效（N-05），环由此断开。
#[test]
fn an_edge_back_in_time_is_ignored() {
    let mut c = graph(
        "lineage-time",
        &[
            ("A", "claude", "PRIMARY", Some("B"), T0),
            ("B", "claude", "PRIMARY", None, T1),
        ],
    );
    assert_eq!(of(&mut c, "A"), ["A"]);
    assert_eq!(of(&mut c, "B"), ["B"]);
    // 环：A → B 有效（B 晚于 A），B → A 无效，仍是一个分量，查找终止。
    let mut c = graph(
        "lineage-cycle",
        &[
            ("A", "claude", "PRIMARY", Some("B"), T0),
            ("B", "claude", "PRIMARY", Some("A"), T1),
        ],
    );
    assert_eq!(of(&mut c, "A"), ["A", "B"]);
}

//! 事件与序号的验收（W1c）：project_seq / global_seq 同事务推进、跨项目独立、恢复后不回退。

use atm_store::events::{
    Appended, EventError, HighWater, NewEvent, append_event, append_global, next_number,
};
use atm_store::open;
use rusqlite::{Connection, Transaction, params};
use std::collections::HashSet;
use std::path::PathBuf;

fn db_path(name: &str) -> PathBuf {
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("target")
        });
    let dir = target.join("store-tests").join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("atm.sqlite")
}

const T: &str = "2026-10-03T00:00:00.000Z";

/// app_meta + 两个项目 PA / PB，各带 work_item 与 record 两个计数器。
fn seeded(name: &str) -> Connection {
    let mut c = open(&db_path(name)).unwrap();
    let tx = c.transaction().unwrap();
    tx.execute(
        "INSERT INTO app_meta (singleton, schema_version, data_root_id, generation, instance_epoch, created_at, updated_at)
         VALUES (1, 1, 'R', 'G', 'E', ?1, ?1)",
        [T],
    )
    .unwrap();
    for (g, id, code) in [(1, "PA", "AAA"), (2, "PB", "BBB")] {
        tx.execute(
            "INSERT INTO scope_generations (gen, scope_kind, scope_id, reason, epoch, created_at) VALUES (?1, 'PROJECT', ?2, 'CREATED', 'E', ?3)",
            params![g, id, T],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO projects (id, code, name, lifecycle, scope_gen, epoch, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'ACTIVE', ?4, 'E', ?5, ?5)",
            params![id, code, format!("Project {code}"), g, T],
        )
        .unwrap();
        for counter in ["work_item", "record"] {
            tx.execute(
                "INSERT INTO counters (project_id, name, next_value) VALUES (?1, ?2, 1)",
                [id, counter],
            )
            .unwrap();
        }
    }
    tx.commit().unwrap();
    c
}

fn ev<'a>(project_id: &'a str, kind: &'a str) -> NewEvent<'a> {
    NewEvent {
        project_id,
        kind,
        actor_type: "AGENT",
        actor_id: "claude",
        session_id: None,
        aggregate_type: "WORK_ITEM",
        aggregate_id: "W1",
        correlation_id: None,
        op_id: Some("op-1"),
        payload_json: r#"{"title":"t","projectSequence":-1}"#,
        at: T,
    }
}

fn scalar(tx: &Transaction<'_>, sql: &str) -> i64 {
    tx.query_row(sql, [], |r| r.get(0)).unwrap()
}

#[test]
fn project_and_global_sequences_advance_together_and_atomically() {
    let mut c = seeded("events-basic");
    let tx = c.transaction().unwrap();
    let got: Vec<Appended> = ["PA", "PA", "PB", "PA", "PB"]
        .iter()
        .map(|p| append_event(&tx, &ev(p, "task.created")).unwrap())
        .collect();
    let seqs: Vec<(i64, i64)> = got.iter().map(|a| (a.seq, a.global_seq)).collect();
    assert_eq!(seqs, vec![(1, 1), (2, 2), (1, 3), (3, 4), (2, 5)]);
    assert_eq!(
        scalar(&tx, "SELECT project_seq FROM projects WHERE id = 'PA'"),
        3
    );
    assert_eq!(
        scalar(&tx, "SELECT project_seq FROM projects WHERE id = 'PB'"),
        2
    );
    assert_eq!(scalar(&tx, "SELECT global_seq FROM app_meta"), 5);

    // 每条事件都有且只有一条镜像，字段与 2.0 投影一致。
    let a3 = &got[3];
    let (kind, agg, actor, dedupe, pid, eid, pseq, code, name, src_eid, title): (
        String,
        String,
        String,
        String,
        String,
        String,
        i64,
        String,
        String,
        String,
        String,
    ) = tx
        .query_row(
            "SELECT type, aggregate_id, actor, dedupe_key, project_id, event_id,
                    payload_json ->> '$.projectSequence', payload_json ->> '$.projectCode', payload_json ->> '$.projectName',
                    payload_json ->> '$.sourceEventId', payload_json ->> '$.title'
             FROM global_feed WHERE global_seq = ?1",
            [a3.global_seq],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                    r.get(8)?,
                    r.get(9)?,
                    r.get(10)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        (kind.as_str(), agg.as_str(), actor.as_str()),
        ("task.created", "W1", "claude")
    );
    assert_eq!(dedupe, format!("project:PA:event:{}", a3.event_id));
    assert_eq!((pid.as_str(), eid.as_str()), ("PA", a3.event_id.as_str()));
    assert_eq!(
        pseq, 3,
        "the mirror's projectSequence overrides the event payload's"
    );
    assert_eq!(
        (code.as_str(), name.as_str(), title.as_str()),
        ("AAA", "Project AAA", "t")
    );
    assert_eq!(src_eid, a3.event_id);
    let event_payload: String = tx
        .query_row(
            "SELECT payload_json FROM events WHERE project_id = 'PA' AND seq = 3",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        event_payload, r#"{"title":"t","projectSequence":-1}"#,
        "the project event keeps its payload byte for byte"
    );
    assert_eq!(scalar(&tx, "SELECT count(*) FROM global_feed"), 5);

    // ULID：26 位 Crockford，互不相同。
    let ids: HashSet<&str> = got.iter().map(|a| a.event_id.as_str()).collect();
    assert_eq!(ids.len(), 5);
    assert!(ids.iter().all(|i| {
        i.len() == 26
            && i.bytes()
                .all(|b| b"0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(&b))
    }));
    tx.commit().unwrap();

    // 事务没提交：事件、镜像、两个序号全都不留痕。
    {
        let tx = c.transaction().unwrap();
        append_event(&tx, &ev("PA", "task.updated")).unwrap();
        drop(tx);
    }
    let tx = c.transaction().unwrap();
    assert_eq!(scalar(&tx, "SELECT count(*) FROM events"), 5);
    assert_eq!(scalar(&tx, "SELECT count(*) FROM global_feed"), 5);
    assert_eq!(
        scalar(&tx, "SELECT project_seq FROM projects WHERE id = 'PA'"),
        3
    );
    assert_eq!(scalar(&tx, "SELECT global_seq FROM app_meta"), 5);
}

#[test]
fn public_numbers_are_per_project_and_per_counter() {
    let mut c = seeded("events-numbers");
    let tx = c.transaction().unwrap();
    assert_eq!(next_number(&tx, "PA", "work_item").unwrap(), 1);
    assert_eq!(next_number(&tx, "PA", "work_item").unwrap(), 2);
    assert_eq!(next_number(&tx, "PB", "work_item").unwrap(), 1);
    assert_eq!(next_number(&tx, "PA", "record").unwrap(), 1);
    assert!(
        matches!(next_number(&tx, "PA", "nope"), Err(EventError::CounterNotFound(n)) if n == "nope")
    );
}

#[test]
fn a_restore_never_rewinds_sequences_or_numbers() {
    let mut c = seeded("events-restore");
    let tx = c.transaction().unwrap();
    let mut seen = HashSet::new();
    for _ in 0..5 {
        seen.insert(
            append_event(&tx, &ev("PA", "task.created"))
                .unwrap()
                .event_id,
        );
        next_number(&tx, "PA", "work_item").unwrap();
    }
    let before = HighWater::capture(&tx, "PA").unwrap();
    assert_eq!(before.project_seq, 5);
    assert_eq!(
        before.counters,
        vec![("record".to_string(), 1), ("work_item".to_string(), 6)]
    );
    let global_before = scalar(&tx, "SELECT global_seq FROM app_meta");

    // 模拟写回一个 seq 2 时的备份：项目流截到 2，计数器回到 3，备份里还没有 record 计数器。
    tx.execute("DELETE FROM events WHERE project_id = 'PA' AND seq > 2", [])
        .unwrap();
    tx.execute("UPDATE projects SET project_seq = 2 WHERE id = 'PA'", [])
        .unwrap();
    tx.execute(
        "UPDATE counters SET next_value = 3 WHERE project_id = 'PA' AND name = 'work_item'",
        [],
    )
    .unwrap();
    tx.execute(
        "DELETE FROM counters WHERE project_id = 'PA' AND name = 'record'",
        [],
    )
    .unwrap();

    assert_eq!(before.reapply(&tx).unwrap(), 5);
    let next = append_event(&tx, &ev("PA", "project.restored")).unwrap();
    assert_eq!(
        next.seq, 6,
        "seq 3..5 were used before the restore and must not be handed out again"
    );
    assert!(
        next.global_seq > global_before,
        "the global stream only moves forward"
    );
    assert!(seen.insert(next.event_id));
    assert_eq!(
        next_number(&tx, "PA", "work_item").unwrap(),
        6,
        "task numbers skip, never repeat (R5)"
    );
    assert_eq!(
        next_number(&tx, "PA", "record").unwrap(),
        1,
        "a counter missing from the backup comes back"
    );
    // 另一个项目不受影响。
    assert_eq!(append_event(&tx, &ev("PB", "task.created")).unwrap().seq, 1);

    // 备份的高水位比恢复前还高（理论上不会出现）：取两者较大的。
    let low = HighWater {
        project_id: "PA".into(),
        project_seq: 1,
        counters: vec![("work_item".into(), 2)],
    };
    tx.execute("UPDATE projects SET project_seq = 40 WHERE id = 'PA'", [])
        .unwrap();
    tx.execute(
        "UPDATE counters SET next_value = 50 WHERE project_id = 'PA' AND name = 'work_item'",
        [],
    )
    .unwrap();
    assert_eq!(low.reapply(&tx).unwrap(), 40);
    assert_eq!(next_number(&tx, "PA", "work_item").unwrap(), 50);
}

#[test]
fn global_only_events_dedupe_and_share_the_global_sequence() {
    let mut c = seeded("events-global");
    let tx = c.transaction().unwrap();
    let a = append_global(
        &tx,
        "backup.created",
        "B1",
        "SYSTEM",
        "{}",
        Some("backup:B1"),
        T,
    )
    .unwrap();
    let p = append_event(&tx, &ev("PA", "task.created")).unwrap();
    let again = append_global(
        &tx,
        "backup.created",
        "B1",
        "SYSTEM",
        "{}",
        Some("backup:B1"),
        T,
    )
    .unwrap();
    let b = append_global(&tx, "backup.failed", "B2", "SYSTEM", "{}", None, T).unwrap();
    assert_eq!((a, p.global_seq, again, b), (1, 2, 1, 3));
    assert_eq!(scalar(&tx, "SELECT count(*) FROM global_feed"), 3);
    assert_eq!(
        scalar(
            &tx,
            "SELECT count(*) FROM global_feed WHERE project_id IS NULL AND event_id IS NULL"
        ),
        2
    );
}

#[test]
fn bad_inputs_are_refused() {
    let mut c = seeded("events-errors");
    let tx = c.transaction().unwrap();
    assert!(
        matches!(append_event(&tx, &ev("NOPE", "x")), Err(EventError::ProjectNotFound(p)) if p == "NOPE")
    );
    for payload in ["[1]", "\"s\"", "not json", "null"] {
        let e = NewEvent {
            payload_json: payload,
            ..ev("PA", "x")
        };
        assert!(
            matches!(append_event(&tx, &e), Err(EventError::PayloadNotObject)),
            "{payload}"
        );
    }
    assert_eq!(
        scalar(&tx, "SELECT project_seq FROM projects WHERE id = 'PA'"),
        0
    );
    assert!(matches!(
        HighWater::capture(&tx, "NOPE"),
        Err(EventError::ProjectNotFound(_))
    ));
    drop(tx);

    // 没种 app_meta 的库：拿不到 global_seq。
    let mut bare = open(&db_path("events-no-meta")).unwrap();
    let tx = bare.transaction().unwrap();
    assert!(matches!(
        append_global(&tx, "x", "a", "SYSTEM", "{}", None, T),
        Err(EventError::MetaMissing)
    ));
}

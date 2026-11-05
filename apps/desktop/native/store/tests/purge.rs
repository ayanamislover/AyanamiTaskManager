use atm_store::purge::{PROJECT_ROWS, PurgeError, delete_live_rows, finish_pending, purge_project};
use atm_store::{Config, Store};
use rusqlite::{Connection, OptionalExtension, params};
use std::fs;
use std::time::Duration;

fn database() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("PRAGMA foreign_keys = ON").unwrap();
    db.execute_batch(include_str!("../migrations/0001_schema_v1.sql"))
        .unwrap();
    db.execute_batch(
        "INSERT INTO scope_generations(gen, scope_kind, scope_id, reason, epoch, created_at)
         VALUES (1,'PROJECT','OLD','CREATED','E1','2026-01-01'),
                (2,'PROJECT','KEEP','CREATED','E2','2026-01-01');
         INSERT INTO projects(id, code, name, lifecycle, scope_gen, epoch, created_at, updated_at)
         VALUES ('OLD','OLD','Old project','TRASHED',1,'E1','2026-01-01','2026-01-01'),
                ('KEEP','KEEP','Keep project','ACTIVE',2,'E2','2026-01-01','2026-01-01');
         INSERT INTO project_paths(id, project_id, path_key, canonical_path, last_seen_at)
         VALUES ('PATH-OLD','OLD','r:\\old','R:\\Old','2026-01-01'),
                ('PATH-KEEP','KEEP','r:\\keep','R:\\Keep','2026-01-01');
         INSERT INTO records(project_id,id,local_no,kind,title,summary,importance,status,actor,created_at,updated_at)
         VALUES ('OLD','R1',1,'FACT','Secret','Old content','NORMAL','ACTIVE','agent','2026-01-01','2026-01-01'),
                ('KEEP','R2',1,'FACT','Keep','Other content','NORMAL','ACTIVE','agent','2026-01-01','2026-01-01');
         INSERT INTO quick_tasks(id,local_no,title,status,actor,promoted_project_id,created_at,updated_at)
         VALUES ('Q1',1,'Old promoted','PROMOTED','agent','OLD','2026-01-01','2026-01-01');
         INSERT INTO quick_task_updates(id,quick_task_id,summary,actor,created_at)
         VALUES ('QU1','Q1','Old update','agent','2026-01-01');
         INSERT INTO global_feed(global_seq,type,aggregate_id,actor,payload_json,created_at,project_id)
         VALUES (1,'project.trashed','OLD','USER','{}','2026-01-01','OLD'),
                (2,'project.created','KEEP','USER','{}','2026-01-01','KEEP');
         INSERT INTO search_docs(project_id,entity_type,entity_id,entity_key,title,body,updated_at)
         VALUES ('OLD','RECORD','R1','OLD-R-1','Secret','Old content','2026-01-01'),
                ('KEEP','RECORD','R2','KEEP-R-1','Keep','Other content','2026-01-01');
         INSERT INTO sync_published(project_code,h,d,head_json)
         VALUES ('OLD','h','d','{}'),('KEEP','h','d','{}');",
    )
    .unwrap();
    db
}

fn count(db: &Connection, table: &str, predicate: &str) -> i64 {
    db.query_row(
        &format!("SELECT count(*) FROM {table} WHERE {predicate}"),
        [],
        |r| r.get(0),
    )
    .unwrap()
}

#[test]
fn removes_only_the_old_identity_and_leaves_other_projects_untouched() {
    let mut db = database();
    // GLOBAL receipts and global events hold copies of the promoted quick task and the project's
    // saved view. Records of *other* entities stay, even when their text mentions those ids.
    db.execute_batch(
        "INSERT INTO saved_views(id,scope,project_id,name,query_json,created_at,updated_at)
         VALUES ('V1','PROJECT','OLD','Old view','{}','2026-01-01','2026-01-01'),
                ('V2','PROJECT','KEEP','Mentions V1','{\"note\":\"V1\"}','2026-01-01','2026-01-01'),
                ('V4','PROJECT','KEEP','Moved from OLD','{}','2026-01-01','2026-01-01'),
                ('V5','GLOBAL',NULL,'Mentions V3','{\"note\":\"V3\"}','2026-01-01','2026-01-01');
         INSERT INTO idempotency_receipts(scope_kind,scope_id,ns_kind,ns_id,op_id,operation,fp_v,fp_family,fingerprint,receipt_json)
         VALUES ('GLOBAL','GLOBAL','GLOBAL','GLOBAL','op-q1','quick.create',2,'canon-v2','f','{\"quick\":{\"id\":\"Q1\",\"title\":\"Old promoted\"}}'),
                ('GLOBAL','GLOBAL','GLOBAL','GLOBAL','op-q1u','quick.update',2,'canon-v2','f','{\"quick\":{\"id\":\"Q1\"},\"changed\":true}'),
                ('GLOBAL','GLOBAL','GLOBAL','GLOBAL','op-q2','quick.create',2,'canon-v2','f','{\"quick\":{\"id\":\"Q12\",\"title\":\"Other\"}}'),
                ('GLOBAL','GLOBAL','GLOBAL','GLOBAL','op-q9','quick.create',2,'canon-v2','f','{\"quick\":{\"id\":\"Q9\",\"note\":\"Q1\",\"title\":\"OLD\"}}'),
                ('GLOBAL','GLOBAL','GLOBAL','GLOBAL','op-v1','saved_view.create',2,'canon-v2','f','{\"view\":{\"id\":\"V1\",\"name\":\"Old view\"}}'),
                ('GLOBAL','GLOBAL','GLOBAL','GLOBAL','op-v2','saved_view.create',2,'canon-v2','f','{\"view\":{\"id\":\"V2\",\"query\":{\"note\":\"V1\"}}}'),
                ('GLOBAL','GLOBAL','GLOBAL','GLOBAL','op-v3c','saved_view.create',2,'canon-v2','f','{\"view\":{\"id\":\"V3\",\"projectId\":\"OLD\",\"name\":\"Retired\"}}'),
                ('GLOBAL','GLOBAL','GLOBAL','GLOBAL','op-v3u','saved_view.update',2,'canon-v2','f','{\"view\":{\"id\":\"V3\",\"projectId\":\"OLD\",\"name\":\"Retired 2\"}}'),
                ('GLOBAL','GLOBAL','GLOBAL','GLOBAL','op-v3d','saved_view.delete',2,'canon-v2','f','{\"ok\":1,\"id\":\"V3\"}'),
                ('GLOBAL','GLOBAL','GLOBAL','GLOBAL','op-v4','saved_view.create',2,'canon-v2','f','{\"view\":{\"id\":\"V4\",\"projectId\":\"OLD\"}}'),
                ('GLOBAL','GLOBAL','GLOBAL','GLOBAL','op-v5','saved_view.create',2,'canon-v2','f','{\"view\":{\"id\":\"V5\",\"projectId\":null,\"name\":\"Mentions V3\"}}');
         INSERT INTO global_feed(global_seq,type,aggregate_id,actor,payload_json,created_at)
         VALUES (10,'quick.created','Q1','agent','{\"title\":\"Old promoted\"}','2026-01-01'),
                (11,'quick.promoted','Q1','agent','{\"projectId\":\"OLD\"}','2026-01-01'),
                (12,'quick.created','Q9','agent','{\"note\":\"Q1\"}','2026-01-01'),
                (13,'saved_view.created','V1','USER','{\"projectId\":\"OLD\"}','2026-01-01'),
                (14,'saved_view.created','V2','USER','{\"projectId\":\"KEEP\"}','2026-01-01'),
                (15,'saved_view.created','V3','USER','{\"projectId\":\"OLD\"}','2026-01-01'),
                (16,'saved_view.deleted','V3','USER','{\"projectId\":\"OLD\"}','2026-01-01'),
                (17,'saved_view.created','V4','USER','{\"projectId\":\"OLD\"}','2026-01-01'),
                (18,'saved_view.created','V5','USER','{\"projectId\":null}','2026-01-01');",
    )
    .unwrap();
    let tx = db.transaction().unwrap();
    assert!(delete_live_rows(&tx, "OLD").unwrap());
    tx.commit().unwrap();
    for table in ["projects", "project_paths", "records", "search_docs"] {
        let column = if table == "projects" {
            "id"
        } else {
            "project_id"
        };
        assert_eq!(
            count(&db, table, &format!("{column} = 'OLD'")),
            0,
            "{table}"
        );
        assert_eq!(
            count(&db, table, &format!("{column} = 'KEEP'")),
            1,
            "{table}"
        );
    }
    assert_eq!(count(&db, "quick_tasks", "id = 'Q1'"), 0);
    assert_eq!(count(&db, "quick_task_updates", "id = 'QU1'"), 0);
    // V3 was deleted before the project: only its receipts and events remember the owner.
    for gone in ["op-q1", "op-q1u", "op-v1", "op-v3c", "op-v3u", "op-v3d"] {
        assert_eq!(
            count(&db, "idempotency_receipts", &format!("op_id = '{gone}'")),
            0,
            "{gone}"
        );
    }
    // Same id as a prefix, as a note/title, or inside another view's query: not the owner.
    // V4 now lives under KEEP, V5 is a global view that only mentions V3 by name.
    for kept in ["op-q2", "op-q9", "op-v2", "op-v4", "op-v5"] {
        assert_eq!(
            count(&db, "idempotency_receipts", &format!("op_id = '{kept}'")),
            1,
            "{kept}"
        );
    }
    assert_eq!(
        count(&db, "global_feed", "aggregate_id IN ('Q1','V1','V3')"),
        0
    );
    assert_eq!(
        count(&db, "global_feed", "aggregate_id IN ('Q9','V2','V4','V5')"),
        4
    );
    assert_eq!(count(&db, "saved_views", "id = 'V2'"), 1);
    assert_eq!(count(&db, "global_feed", "aggregate_id = 'OLD'"), 0);
    assert_eq!(count(&db, "global_feed", "aggregate_id = 'KEEP'"), 1);
    assert_eq!(count(&db, "sync_published", "project_code = 'OLD'"), 0);
    assert_eq!(count(&db, "sync_published", "project_code = 'KEEP'"), 1);
    assert_eq!(
        count(&db, "settings", "key = 'internal.purged-project.OLD'"),
        1
    );
    let fts: Option<String> = db
        .query_row(
            "SELECT title FROM search_fts WHERE search_fts MATCH 'Secret'",
            [],
            |r| r.get(0),
        )
        .optional()
        .unwrap();
    assert!(fts.is_none());
    // The public code and path may be used by an entirely new identity.
    db.execute("INSERT INTO scope_generations(gen,scope_kind,scope_id,reason,epoch,created_at) VALUES (3,'PROJECT','NEW','CREATED','E3','2026-01-02')", []).unwrap();
    db.execute("INSERT INTO projects(id,code,name,lifecycle,scope_gen,epoch,created_at,updated_at) VALUES ('NEW','OLD','New project','ACTIVE',3,'E3','2026-01-02','2026-01-02')", []).unwrap();
    db.execute("INSERT INTO project_paths(id,project_id,path_key,canonical_path,last_seen_at) VALUES ('PATH-NEW','NEW','r:\\old','R:\\Old','2026-01-02')", []).unwrap();
}

#[test]
fn active_dispatch_prevents_deletion_without_partial_writes() {
    let mut db = database();
    db.execute("INSERT INTO dispatch_runs(run,project_code,task_key,title,origin,state,session_id,created_at,cwd,log_root) VALUES ('RUN','OLD','OLD-T-1','Work','desktop','running','S','2026-01-01','R:\\Old','CURRENT')", []).unwrap();
    let tx = db.transaction().unwrap();
    assert!(delete_live_rows(&tx, "OLD").is_err());
    tx.rollback().unwrap();
    assert_eq!(count(&db, "projects", "id = 'OLD'"), 1);
    assert_eq!(count(&db, "records", "project_id = 'OLD'"), 1);
}

#[test]
fn every_project_id_table_has_an_explicit_purge_policy() {
    let db = database();
    let tables: Vec<String> = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    // quick_tasks / global_feed: deleted by promoted_project_id / aggregate_id in delete_live_rows.
    // legacy_backups: the read-only 2.x catalog is kept for the User's manual import; the purge
    // tombstone hides its rows from Agent-readable backup lists (service `list_backups`).
    let handled_elsewhere = ["quick_tasks", "global_feed", "legacy_backups"];
    for table in tables {
        let mut statement = db.prepare(&format!("PRAGMA table_info({table})")).unwrap();
        let columns: Vec<String> = statement
            .query_map([], |r| r.get(1))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        if columns.iter().any(|c| c == "project_id") {
            assert!(
                PROJECT_ROWS.contains(&table.as_str())
                    || handled_elsewhere.contains(&table.as_str()),
                "new project-scoped table {table} needs a purge policy"
            );
        }
    }
    let old: Option<String> = db
        .query_row(
            "SELECT code FROM projects WHERE id=?1",
            params!["OLD"],
            |r| r.get(0),
        )
        .optional()
        .unwrap();
    assert_eq!(old.as_deref(), Some("OLD"));
}

fn file_world() -> (Store, std::path::PathBuf, std::path::PathBuf) {
    // Under the build directory like the other store tests, named after the running test and
    // cleared first, so a failed run never leaves directories behind in %TEMP%.
    let test = std::thread::current()
        .name()
        .unwrap_or("purge")
        .replace("::", "-");
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("target")
        });
    let root = target.join("store-tests").join(format!("purge-{test}"));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let source = root.join("source");
    fs::create_dir(&source).unwrap();
    let store = Store::open(
        &root.join("atm.sqlite"),
        Config {
            idle_checkpoint: Duration::from_secs(3600),
            ..Config::default()
        },
    )
    .unwrap();
    let source_string = source.to_string_lossy().into_owned();
    store.write(move |tx| {
        tx.execute("INSERT INTO app_meta(singleton,schema_version,data_root_id,generation,instance_epoch,created_at,updated_at) VALUES (1,1,'ROOT','G','E','2026-01-01','2026-01-01')", [])?;
        tx.execute("INSERT INTO scope_generations(gen,scope_kind,scope_id,reason,epoch,created_at) VALUES (1,'PROJECT','OLD','CREATED','E1','2026-01-01')", [])?;
        tx.execute("INSERT INTO projects(id,code,name,lifecycle,scope_gen,epoch,created_at,updated_at) VALUES ('OLD','OLD','Old','TRASHED',1,'E1','2026-01-01','2026-01-01')", [])?;
        tx.execute("INSERT INTO project_paths(id,project_id,path_key,canonical_path,last_seen_at) VALUES ('PATH','OLD','source',?1,'2026-01-01')", [source_string])?;
        Ok::<_, rusqlite::Error>(())
    }).unwrap();
    (store, root, source)
}

#[test]
fn file_cleanup_removes_only_owned_marker_and_attachments_but_keeps_backup() {
    let (store, root, source) = file_world();
    let marker_dir = source.join(".ayanami-task");
    fs::create_dir(&marker_dir).unwrap();
    let marker = marker_dir.join("project.json");
    fs::write(&marker, r#"{"project_id":"OLD","project_code":"OLD"}"#).unwrap();
    fs::write(source.join("keep.txt"), "source survives").unwrap();
    let artifact = root.join("artifacts").join("OLD");
    fs::create_dir_all(&artifact).unwrap();
    fs::write(artifact.join("secret.txt"), "private content").unwrap();
    store.write(|tx| tx.execute("INSERT INTO dispatch_runs(run,project_code,task_key,title,origin,state,session_id,created_at,cwd,log_root) VALUES ('RUN-OLD','OLD','OLD-T-1','Old work','desktop','succeeded','S','2026-01-01','source','CURRENT')", [])).unwrap();
    let logs = root.join("dispatch").join("logs");
    fs::create_dir_all(&logs).unwrap();
    fs::write(logs.join("RUN-OLD.jsonl"), "old log").unwrap();
    fs::write(logs.join("RUN-OLD.stderr.log"), "old stderr").unwrap();
    fs::write(logs.join("KEEP.jsonl"), "keep log").unwrap();
    let backup_root = root.join("backups");
    atm_store::backup::create_backup(&store, &backup_root, "MANUAL", "2026-01-01T00:00:00Z")
        .unwrap();
    let backup_files = fs::read_dir(&backup_root).unwrap().count();

    assert_eq!(purge_project(&store, "OLD", "OLD", 0).unwrap().code, "OLD");
    assert!(!artifact.exists());
    assert!(!marker.exists());
    assert!(!logs.join("RUN-OLD.jsonl").exists());
    assert!(!logs.join("RUN-OLD.stderr.log").exists());
    assert!(logs.join("KEEP.jsonl").exists());
    assert_eq!(
        fs::read_to_string(source.join("keep.txt")).unwrap(),
        "source survives"
    );
    assert_eq!(fs::read_dir(&backup_root).unwrap().count(), backup_files);
    assert_eq!(finish_pending(&store).unwrap().finished, 0);
    let exists: bool = store
        .read(|tx| {
            tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM projects WHERE id='OLD')",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert!(!exists);
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn stale_confirmation_does_not_move_or_erase_files() {
    let (store, root, source) = file_world();
    let artifact = root.join("artifacts").join("OLD");
    fs::create_dir_all(&artifact).unwrap();
    fs::write(artifact.join("keep.txt"), "content").unwrap();
    assert!(matches!(
        purge_project(&store, "OLD", "OLD", 1),
        Err(PurgeError::VersionChanged)
    ));
    assert!(artifact.join("keep.txt").exists());
    assert!(source.exists());
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn enabled_sync_blocks_purge_without_moving_attachments() {
    let (store, root, _) = file_world();
    let attachment = root.join("artifacts").join("OLD");
    fs::create_dir_all(&attachment).unwrap();
    fs::write(attachment.join("keep.txt"), "content").unwrap();
    store
        .write(|tx| {
            tx.execute(
                "INSERT INTO sync_state(singleton,v,enabled,app_id,device_id,device_name,updated_at)
                 VALUES (1,1,1,'APP','DEVICE','test','2026-01-01')",
                [],
            )
        })
        .unwrap();
    assert!(matches!(
        purge_project(&store, "OLD", "OLD", 0),
        Err(PurgeError::SyncEnabled)
    ));
    assert!(attachment.join("keep.txt").exists());
    assert_eq!(finish_pending(&store).unwrap().finished, 0);
    assert!(
        store
            .read(
                |tx| tx.query_row("SELECT 1 FROM projects WHERE id='OLD'", [], |r| r
                    .get::<_, i64>(0))
            )
            .is_ok()
    );
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn queued_dispatch_blocks_purge_without_moving_attachments() {
    let (store, root, _) = file_world();
    let attachment = root.join("artifacts").join("OLD");
    fs::create_dir_all(&attachment).unwrap();
    fs::write(attachment.join("keep.txt"), "content").unwrap();
    store
        .write(|tx| {
            tx.execute(
                "INSERT INTO dispatch_runs(run,project_code,task_key,title,origin,state,session_id,created_at,cwd,log_root)
                 VALUES ('RUN','OLD','OLD-T-1','Work','desktop','queued','S','2026-01-01','source','CURRENT')",
                [],
            )
        })
        .unwrap();
    assert!(matches!(
        purge_project(&store, "OLD", "OLD", 0),
        Err(PurgeError::ActiveDispatch)
    ));
    assert!(attachment.join("keep.txt").exists());
    assert_eq!(finish_pending(&store).unwrap().finished, 0);
    assert!(
        store
            .read(
                |tx| tx.query_row("SELECT 1 FROM projects WHERE id='OLD'", [], |r| r
                    .get::<_, i64>(0))
            )
            .is_ok()
    );
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn interrupted_before_commit_puts_staged_attachments_back() {
    let (store, root, source) = file_world();
    let staging = root.join("artifacts").join(".purge-staging");
    fs::create_dir_all(staging.join("OLD")).unwrap();
    fs::write(staging.join("OLD").join("keep.txt"), "recover me").unwrap();
    fs::write(
        staging.join("OLD.json"),
        serde_json::json!({
            "id": "OLD", "paths": [source.to_string_lossy()]
        })
        .to_string(),
    )
    .unwrap();
    assert_eq!(finish_pending(&store).unwrap().finished, 1);
    assert_eq!(
        fs::read_to_string(root.join("artifacts").join("OLD").join("keep.txt")).unwrap(),
        "recover me"
    );
    assert!(!staging.join("OLD.json").exists());
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn interrupted_after_commit_finishes_only_deleted_projects_files() {
    let (store, root, source) = file_world();
    let marker_dir = source.join(".ayanami-task");
    fs::create_dir(&marker_dir).unwrap();
    let marker = marker_dir.join("project.json");
    fs::write(&marker, r#"{"project_id":"OLD"}"#).unwrap();
    let staging = root.join("artifacts").join(".purge-staging");
    fs::create_dir_all(staging.join("OLD")).unwrap();
    fs::write(staging.join("OLD").join("private.txt"), "erase me").unwrap();
    fs::write(
        staging.join("OLD.json"),
        serde_json::json!({
            "id": "OLD", "paths": [source.to_string_lossy()]
        })
        .to_string(),
    )
    .unwrap();
    store.write(|tx| delete_live_rows(tx, "OLD")).unwrap();
    assert_eq!(finish_pending(&store).unwrap().finished, 1);
    assert!(!staging.join("OLD").exists());
    assert!(!marker.exists());
    assert!(source.exists());
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

/// Make `dispatch/logs/<run>.jsonl` impossible to remove (a directory), so that run's cleanup
/// stays pending the way a file held open by an AV scanner would.
fn stuck_log(root: &std::path::Path, run: &str) {
    fs::create_dir_all(
        root.join("dispatch")
            .join("logs")
            .join(format!("{run}.jsonl")),
    )
    .unwrap();
}

#[test]
fn an_earlier_stuck_cleanup_neither_blocks_nor_becomes_this_deletions_result() {
    let (store, root, _) = file_world();
    let staging = root.join("artifacts").join(".purge-staging");
    fs::create_dir_all(&staging).unwrap();
    fs::write(
        staging.join("GONE.json"),
        r#"{"id":"GONE","paths":[],"currentRuns":["RUN-GONE"]}"#,
    )
    .unwrap();
    stuck_log(&root, "RUN-GONE");

    assert_eq!(purge_project(&store, "OLD", "OLD", 0).unwrap().code, "OLD");
    let exists: bool = store
        .read(|tx| {
            tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM projects WHERE id='OLD')",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert!(!exists);
    assert!(!staging.join("OLD.json").exists());
    // The earlier deletion is still waiting for its own retry.
    assert!(staging.join("GONE.json").exists());
    let settled = finish_pending(&store).unwrap();
    assert_eq!(settled.finished, 0);
    assert_eq!(
        settled
            .pending
            .iter()
            .map(|(id, _)| id.as_str())
            .collect::<Vec<_>>(),
        ["GONE"]
    );
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn this_deletions_own_stuck_cleanup_is_reported_as_committed() {
    let (store, root, _) = file_world();
    store.write(|tx| tx.execute("INSERT INTO dispatch_runs(run,project_code,task_key,title,origin,state,session_id,created_at,cwd,log_root) VALUES ('RUN-OLD','OLD','OLD-T-1','Old work','desktop','succeeded','S','2026-01-01','source','CURRENT')", [])).unwrap();
    stuck_log(&root, "RUN-OLD");
    assert!(matches!(
        purge_project(&store, "OLD", "OLD", 0),
        Err(PurgeError::CleanupPending(_))
    ));
    let exists: bool = store
        .read(|tx| {
            tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM projects WHERE id='OLD')",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert!(
        !exists,
        "the rows are gone even though a file is still pending"
    );
    fs::remove_dir_all(root.join("dispatch").join("logs").join("RUN-OLD.jsonl")).unwrap();
    assert_eq!(finish_pending(&store).unwrap().finished, 1);
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

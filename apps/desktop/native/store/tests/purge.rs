use atm_store::purge::{PROJECT_ROWS, PurgeError, delete_live_rows, finish_pending, purge_project};
use atm_store::{Config, Store};
use rusqlite::{Connection, OptionalExtension, params};
use std::fs;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("atm-purge-test-{}-{stamp}", std::process::id()));
    fs::create_dir(&root).unwrap();
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
    assert_eq!(finish_pending(&store).unwrap(), 0);
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
    assert_eq!(finish_pending(&store).unwrap(), 0);
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
    assert_eq!(finish_pending(&store).unwrap(), 0);
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
    assert_eq!(finish_pending(&store).unwrap(), 1);
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
    assert_eq!(finish_pending(&store).unwrap(), 1);
    assert!(!staging.join("OLD").exists());
    assert!(!marker.exists());
    assert!(source.exists());
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

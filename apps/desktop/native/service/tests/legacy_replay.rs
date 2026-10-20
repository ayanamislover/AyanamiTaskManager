//! W3c 幂等重放模拟（07 §3 VERIFY「幂等重放模拟」）：一个 2.x 项目库里的旧回执经转换器落进 3.0 的库，
//! 服务按同一个 session 与 op_id 重发同一个请求，必须 REPLAY 出保存的结果；请求不同则冲突；新的 op_id 照常写入。
//! 旧回执的指纹按 2.x 的 kernel-v1 算法从真实请求算出，不是手写的常量。

mod support;

use atm_domain::error::ErrorCode;
use atm_service::fp::{self, JsValue};
use atm_service::memory::ProgressRequest;
use atm_service::work::Target;
use atm_service::write::Service;
use atm_store::legacy::{ConvertOptions, LegacySources, convert};
use atm_store::{Config, Store};
use rusqlite::{Connection, params};
use serde_json::json;
use std::path::{Path, PathBuf};
use support::{agent, test_root};

const T: &str = "2026-09-01T00:00:00.000Z";

/// 按仓库里 2.x 的迁移文件建一个库，并像 2.0 的迁移执行器那样登记 schema_migrations。
fn legacy(path: &Path, kind: &str) -> Connection {
    use sha2::Digest;
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../migrations")
        .join(kind);
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    files.sort();
    let c = Connection::open(path).unwrap();
    c.execute_batch(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL,
           content_sha256 TEXT NOT NULL, hash_origin TEXT NOT NULL CHECK(hash_origin IN ('APPLIED','LEGACY_BASELINE_UNVERIFIED')))",
    )
    .unwrap();
    for f in files {
        let name = f.file_name().unwrap().to_string_lossy().into_owned();
        let sql = std::fs::read(&f).unwrap();
        let sha: String = sha2::Sha256::digest(&sql)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        c.execute_batch(std::str::from_utf8(&sql).unwrap()).unwrap();
        c.execute(
            "INSERT INTO schema_migrations VALUES (?1, ?2, ?3, ?4, 'APPLIED')",
            params![name[..4].parse::<i64>().unwrap(), name, T, sha],
        )
        .unwrap();
    }
    c
}

/// 2.x 的 `work.progress` 请求在 kernel-v1 里的形状（progress-commands.ts 的 normalizedInput）。
fn v1_progress(key: &str, summary: &str, percent: f64) -> String {
    fp::kernel_v1(&JsValue::from_json(&json!({
        "taskKey": key, "summary": summary, "completed": [], "next": [], "evidence": [], "percent": percent,
    })))
    .unwrap()
}

/// 一个 2.x 数据集：registry 加一个项目库 P1（AAA），里面有目标 OBJ、Agent claude 的在线 session S1、
/// S1 认领的进行中任务 W1（AAA-T-0001）。返回 (目录, 项目库路径)。
fn two_x(name: &str) -> (PathBuf, PathBuf) {
    let dir = test_root().join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let project = dir.join("P1.sqlite");

    let r = legacy(&dir.join("registry.sqlite"), "registry");
    r.execute(
        "INSERT INTO app_meta (singleton, current_sequence, data_version, created_at, updated_at) VALUES (1, 0, 1, ?1, ?1)",
        [T],
    )
    .unwrap();
    r.execute(
        "INSERT INTO projects (id, code, name, description, db_path, lifecycle, coordination_mode, version, created_at, updated_at)
         VALUES ('P1', 'AAA', 'Alpha', '', ?1, 'ACTIVE', 'AUTO', 0, ?2, ?2)",
        params![project.to_string_lossy(), T],
    )
    .unwrap();
    drop(r);

    let p = legacy(&project, "project");
    let schema: i64 = p
        .query_row("SELECT max(version) FROM schema_migrations", [], |r| {
            r.get(0)
        })
        .unwrap();
    p.execute_batch(&format!(
        "INSERT INTO project_meta (singleton, project_id, project_code, name, description, lifecycle, coordination_mode, health,
                                   current_sequence, schema_version, version, created_at, updated_at)
           VALUES (1, 'P1', 'AAA', 'Alpha', '', 'ACTIVE', 'AUTO', 'UNKNOWN', 7, {schema}, 0, '{T}', '{T}');
         INSERT INTO counters (name, next_value) VALUES ('objective', 2), ('milestone', 1), ('work_item', 2), ('blocker', 1), ('record', 1);
         INSERT INTO objectives (id, local_no, title, status, created_at, updated_at) VALUES ('OBJ', 1, 'goal', 'ACTIVE', '{T}', '{T}');
         INSERT INTO agents (id, display_name, client_kind, created_at, updated_at) VALUES ('claude', 'Claude', 'cli', '{T}', '{T}');
         INSERT INTO agent_sessions (id, agent_id, role, work_state, connection_state, started_at, updated_at)
           VALUES ('S1', 'claude', 'PRIMARY', 'WORKING', 'ONLINE', '{T}', '{T}');
         INSERT INTO work_items (id, local_no, objective_id, type, title, status, phase, priority, claimed_by_session_id, created_at, updated_at)
           VALUES ('W1', 1, 'OBJ', 'TASK', 'task one', 'IN_PROGRESS', 'IN_PROGRESS', 'NORMAL', 'S1', '{T}', '{T}');"
    ))
    .unwrap();
    drop(p);
    (dir, project)
}

/// 转换成 3.0 的单库（不按数据根输入），断言 VERIFY 没有失败。
fn convert_2x(dir: &Path, project: &Path) -> PathBuf {
    let target = dir.join("out").join("atm.sqlite");
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    let report = convert(
        &LegacySources {
            registry: dir.join("registry.sqlite"),
            knowledge: None,
            projects: vec![project.to_path_buf()],
            root: None,
        },
        &target,
        &ConvertOptions {
            at: "2026-10-03T00:00:00.000Z",
            allow_real_data_root: false,
            real_data_root: None,
            generation: None,
            secrets_check: None,
            accept_unconvertible: &[],
            origin_root: None,
            progress: None,
        },
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert!(report.failures().is_empty(), "{:?}", report.failures());
    target
}

#[test]
fn converted_2x_receipts_replay_through_the_service() {
    let (dir, project) = two_x("legacy-replay");
    let p = Connection::open(&project).unwrap();
    // 2.x 的 Agent 回执：key = `<session>:<op_id>`，指纹 = kernel-v1(normalizedInput)。
    p.execute(
        "INSERT INTO idempotency_keys (key, operation, request_fingerprint, response_json, created_at, op_id, actor_session_id)
         VALUES ('S1:pg-old', 'work.progress', ?1, '{\"sequence\":7}', ?2, 'pg-old', 'S1')",
        params![v1_progress("AAA-T-0001", "旧的", 20.0), T],
    )
    .unwrap();
    drop(p);

    let target = convert_2x(&dir, &project);

    let svc = Service::new(Store::open(&target, Config::default()).unwrap());
    let old = Target::new("P1", Some("S1"), "pg-old");
    let request = |summary: &str, percent: f64| ProgressRequest {
        percent: Some(percent),
        ..ProgressRequest::task("AAA-T-0001", summary)
    };
    // 同一个请求：REPLAY 出 2.x 保存的结果，不写任何东西。
    let replay = svc
        .add_progress(&agent(), &old, request("旧的", 20.0))
        .unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.result["sequence"], 7);
    // 同一个 op_id、不同的请求：冲突。
    let e = svc
        .add_progress(&agent(), &old, request("改过的", 20.0))
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::IDEMPOTENCY_CONFLICT, "{e:?}");
    // 新的 op_id：照常写入，序号接着 2.x 的往后排。
    let fresh = svc
        .add_progress(
            &agent(),
            &Target::new("P1", Some("S1"), "pg-new"),
            request("新的", 30.0),
        )
        .unwrap();
    assert!(!fresh.replayed);
    assert_eq!(fresh.result["sequence"], 8);
}

// ---------- W3a peer r2 P2-R2-02：N-02g 的后果（store/NORMALIZATION.md「N-02g 的后果」） ----------

use atm_domain::evidence::{Evidence, EvidenceKind};
use atm_domain::gate::{ChecklistStatus, GateChecklist, GateInput, evaluate};
use atm_domain::progress::{ChecklistWeight, ProgressSource, compute};
use atm_domain::work::{Operation, Phase, Status, WorkState};
use atm_service::work::{ChecklistSingle, PatchItem, ReviewRequest, ReviewSubmit, Verdict};

/// 完成门：对每一种 (kind, status, evidence_required, 证据条数)，2.0 的结论（01 §4：检查项谓词排除 OPTIONAL
/// 与已关闭的项；证据谓词不看 kind，看必证、未 SKIPPED，以及 DONE 时有没有证据）与 N-02g 改写之后 3.0 的结论相同。
/// 原因列表可以不同（例如必证的 OPTIONAL TODO：2.0 只有证据一条，3.0 检查项与证据各一条），用例数出这些情况。
#[test]
fn n02g_keeps_every_gate_verdict_and_says_where_reasons_differ() {
    let statuses = [
        ChecklistStatus::Todo,
        ChecklistStatus::Doing,
        ChecklistStatus::Done,
        ChecklistStatus::Skipped,
    ];
    let (mut cases, mut reasons_differ) = (0, Vec::new());
    for kind in ["ACCEPTANCE", "OPTIONAL", "REQUIRED", "VERIFICATION"] {
        for old in statuses {
            for required in [false, true] {
                for evidence in [0usize, 1] {
                    let closed = matches!(old, ChecklistStatus::Done | ChecklistStatus::Skipped);
                    let open_2x = kind != "OPTIONAL" && !closed;
                    let evidence_2x = required
                        && old != ChecklistStatus::Skipped
                        && (old != ChecklistStatus::Done || evidence == 0);
                    // N-02g：不必证、未完成的 OPTIONAL 改为 SKIPPED，kind 一律 ACCEPTANCE。
                    let new = if kind == "OPTIONAL" && !required && !closed {
                        ChecklistStatus::Skipped
                    } else {
                        old
                    };
                    let outcome = evaluate(&GateInput {
                        state: WorkState::plain(Phase::InProgress),
                        verification_required: false,
                        checklist: vec![GateChecklist {
                            id: "C".into(),
                            status: new,
                            evidence_required: required,
                            evidence_count: evidence,
                        }],
                        children: vec![],
                        blockers: vec![],
                        dependencies: vec![],
                    });
                    let case = format!("{kind} {old:?} required={required} evidence={evidence}");
                    assert_eq!(outcome.passed(), !(open_2x || evidence_2x), "{case}");
                    if outcome.reasons.len() != usize::from(open_2x) + usize::from(evidence_2x) {
                        reasons_differ.push(case);
                    }
                    cases += 1;
                }
            }
        }
    }
    assert_eq!(cases, 64);
    // 只有「必证、未完成的 OPTIONAL」：2.0 只报证据，3.0 还报检查项未关。
    assert_eq!(
        reasons_differ,
        [
            "OPTIONAL Todo required=true evidence=0",
            "OPTIONAL Todo required=true evidence=1",
            "OPTIONAL Doing required=true evidence=0",
            "OPTIONAL Doing required=true evidence=1",
        ]
    );
}

/// 进度：SKIPPED 的检查项不计（W-110），所以 3.0 下次重算时进度会变——与 TODO 同列时上升，
/// 是唯一检查项时退到上报值。
#[test]
fn n02g_changes_progress_at_the_next_recompute() {
    let weight = |status| ChecklistWeight {
        status,
        weight: 1.0,
    };
    let with_done = |optional| {
        compute(
            Status::InProgress,
            &[],
            &[weight(optional), weight(ChecklistStatus::Done)],
            None,
        )
    };
    assert_eq!(with_done(ChecklistStatus::Todo).value, 50.0);
    assert_eq!(with_done(ChecklistStatus::Skipped).value, 99.0);
    let alone = |optional| compute(Status::InProgress, &[], &[weight(optional)], Some(80.0));
    let (before, after) = (
        alone(ChecklistStatus::Todo),
        alone(ChecklistStatus::Skipped),
    );
    assert_eq!(
        (before.value, before.source),
        (0.0, ProgressSource::Checklist)
    );
    assert_eq!(
        (after.value, after.source),
        (80.0, ProgressSource::Reported)
    );
}

fn read<T: rusqlite::types::FromSql>(db: &Path, sql: &str) -> T {
    Connection::open(db)
        .unwrap()
        .query_row(sql, [], |r| r.get(0))
        .unwrap()
}

/// 真实转换出的库接入服务：
/// - 转换后读到的是 2.x 存下的进度（不在转换时重算）；下一次涉及该任务的写入按 3.0 规则重算；
/// - 被改成 SKIPPED 的检查项不能发起新的 Review（`REVIEW_CHECKLIST_CLOSED`），用检查项更新改回 TODO 就能重开；
/// - 2.x 里已经绑定在这类检查项上的 Review 请求照常提交（N-03 保留了版本）：APPROVED 把父检查项置为 DONE，
///   CHANGES_REQUESTED 不动它。
///
/// 进度看 W1（只有检查项）；Review 挂在另一个任务 W4 下——有子项的任务按子项算进度（W-110），看不出检查项的变化。
#[test]
fn n02g_consequences_hold_on_a_converted_target() {
    let (dir, project) = two_x("legacy-n02g");
    Connection::open(&project)
        .unwrap()
        .execute_batch(&format!(
            "UPDATE counters SET next_value = 6 WHERE name = 'work_item';
             UPDATE counters SET next_value = 3 WHERE name = 'review_request';
             UPDATE work_items SET computed_progress = 50, progress_source = 'CHECKLIST' WHERE id = 'W1';
             INSERT INTO work_items (id, local_no, objective_id, type, title, status, phase, priority, claimed_by_session_id, created_at, updated_at)
               VALUES ('W4', 4, 'OBJ', 'TASK', 'task under review', 'IN_PROGRESS', 'IN_PROGRESS', 'NORMAL', 'S1', '{T}', '{T}');
             INSERT INTO checklist_items (id, work_item_id, title, kind, status, created_at, updated_at) VALUES
               ('C1', 'W1', 'optional, not done', 'OPTIONAL', 'TODO', '{T}', '{T}'),
               ('C2', 'W1', 'required, done', 'REQUIRED', 'DONE', '{T}', '{T}'),
               ('C3', 'W4', 'optional, under review', 'OPTIONAL', 'TODO', '{T}', '{T}'),
               ('C4', 'W4', 'optional, to review', 'OPTIONAL', 'TODO', '{T}', '{T}'),
               ('C5', 'W4', 'optional, sent back', 'OPTIONAL', 'TODO', '{T}', '{T}');
             INSERT INTO agents (id, display_name, client_kind, created_at, updated_at) VALUES ('codex', 'Codex', 'cli', '{T}', '{T}');
             INSERT INTO agent_sessions (id, agent_id, role, work_state, connection_state, started_at, updated_at)
               VALUES ('RV', 'codex', 'REVIEWER', 'WORKING', 'ONLINE', '{T}', '{T}');
             INSERT INTO work_items (id, local_no, parent_id, objective_id, type, title, status, phase, priority, created_at, updated_at) VALUES
               ('W2', 2, 'W4', 'OBJ', 'REVIEW', 'bound review', 'READY', 'READY', 'NORMAL', '{T}', '{T}'),
               ('W3', 3, 'W4', 'OBJ', 'REVIEW', 'new review', 'READY', 'READY', 'NORMAL', '{T}', '{T}'),
               ('W5', 5, 'W4', 'OBJ', 'REVIEW', 'bound review, sent back', 'READY', 'READY', 'NORMAL', '{T}', '{T}');
             INSERT INTO review_requests (id, local_no, review_work_item_id, parent_work_item_id, parent_checklist_id,
                                          parent_checklist_version, expected_candidate_hashes_json, created_by_agent_id,
                                          created_by_session_id, created_at, op_id)
               VALUES ('RR1', 1, 'W2', 'W4', 'C3', 0, '[{{\"name\":\"source\",\"value\":\"abcdef1\"}}]', 'claude', 'S1', '{T}', 'rr1'),
                      ('RR2', 2, 'W5', 'W4', 'C5', 0, '[{{\"name\":\"source\",\"value\":\"abcdef1\"}}]', 'claude', 'S1', '{T}', 'rr2');"
        ))
        .unwrap();
    let target = convert_2x(&dir, &project);
    let checklist = |id: &str, column: &str| -> String {
        read(
            &target,
            &format!(
                "SELECT CAST({column} AS TEXT) FROM checklist_items WHERE project_id = 'P1' AND id = '{id}'"
            ),
        )
    };
    let progress = || -> (f64, String) {
        (
            read(
                &target,
                "SELECT computed_progress FROM work_items WHERE project_id = 'P1' AND id = 'W1'",
            ),
            read(
                &target,
                "SELECT progress_source FROM work_items WHERE project_id = 'P1' AND id = 'W1'",
            ),
        )
    };
    for id in ["C1", "C3", "C4", "C5"] {
        assert_eq!(
            (checklist(id, "kind"), checklist(id, "status")),
            ("ACCEPTANCE".into(), "SKIPPED".into())
        );
        assert_eq!(checklist(id, "version"), "0");
    }
    // 转换不重算：读到的是 2.x 存的值。
    assert_eq!(progress(), (50.0, "CHECKLIST".into()));

    let svc = Service::new(Store::open(&target, Config::default()).unwrap());
    let s1 = |op: &str| Target::new("P1", Some("S1"), op);
    let rv = |op: &str| Target::new("P1", Some("RV"), op);

    // 下一次涉及 W1 的写入按 3.0 重算：C1 是 SKIPPED，只剩 C2（DONE），未完成的任务最多 99。
    svc.add_progress(
        &agent(),
        &s1("note"),
        ProgressRequest::task("AAA-T-0001", "after the upgrade"),
    )
    .unwrap();
    assert_eq!(progress(), (99.0, "CHECKLIST".into()));

    // 新 Review：SKIPPED 的检查项拒绝；改回 TODO 后可以发起。
    let new_request = |version: i64| ReviewRequest {
        review_task_key: "AAA-T-0003".into(),
        expected_review_task_version: Some(0),
        parent_checklist_id: "C4".into(),
        expected_parent_checklist_version: version,
        candidate_hashes: vec![("source".into(), "abcdef1".into())],
    };
    let e = svc
        .request_review(&agent(), &s1("rq-closed"), new_request(0))
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::REVIEW_CHECKLIST_CLOSED, "{e:?}");
    svc.update_checklist(
        &agent(),
        &s1("reopen"),
        ChecklistSingle {
            task_key: Some("AAA-T-0004".into()),
            checklist_id: "C4".into(),
            expected_checklist_version: Some(0),
            legacy_version_name: false,
            status: ChecklistStatus::Todo,
            evidence: None,
        },
    )
    .unwrap();
    assert_eq!(checklist("C4", "status"), "TODO");
    svc.request_review(&agent(), &s1("rq-open"), new_request(1))
        .unwrap();

    // 已有的请求：绑定照旧，评审者提交 APPROVED，父检查项 C3 从 SKIPPED 变 DONE。
    svc.patch_work_items(
        &agent(),
        &rv("start"),
        vec![PatchItem::new("AAA-T-0002", Operation::Start)],
    )
    .unwrap();
    svc.submit_review(
        &agent(),
        &rv("submit"),
        ReviewSubmit {
            request_key: "AAA-RR-0001".into(),
            review_task_key: Some("AAA-T-0002".into()),
            expected_review_task_version: Some(1),
            verdict: Verdict::Approved,
            reviewed_hashes: vec![("source".into(), "abcdef1".into())],
            evidence: vec![Evidence::Item {
                kind: EvidenceKind::TestResult,
                value: "reviewed after the upgrade".into(),
                note: None,
            }],
        },
    )
    .unwrap();
    assert_eq!(checklist("C3", "status"), "DONE");
    svc.patch_work_items(
        &agent(),
        &rv("start-2"),
        vec![PatchItem::new("AAA-T-0005", Operation::Start)],
    )
    .unwrap();
    svc.submit_review(
        &agent(),
        &rv("submit-2"),
        ReviewSubmit {
            request_key: "AAA-RR-0002".into(),
            review_task_key: Some("AAA-T-0005".into()),
            expected_review_task_version: Some(1),
            verdict: Verdict::ChangesRequested,
            reviewed_hashes: vec![("source".into(), "abcdef1".into())],
            evidence: vec![Evidence::Item {
                kind: EvidenceKind::TestResult,
                value: "sent back after the upgrade".into(),
                note: None,
            }],
        },
    )
    .unwrap();
    assert_eq!(checklist("C5", "status"), "SKIPPED");
    assert_eq!(
        read::<String>(
            &target,
            "SELECT status FROM work_items WHERE project_id = 'P1' AND id = 'W5'"
        ),
        "DONE"
    );
}

//! 项目生命周期、路径与 begin ③④⑤ 的验收（W2g1；04 L-001～L-012，D32、D33；10 A3；03 C-11）。

mod support;

use atm_domain::error::ErrorCode;
use atm_domain::work::Operation;
use atm_service::backups::RestoreScope;
use atm_service::project::{CreateProjectRequest, PathInfo, Transition};
use atm_service::session::{BeginRequest, EndRequest, Outcome, ProjectSelector};
use atm_service::work::Target;
use atm_service::write::{Service, Written};
use atm_store::paths::path_key;
use serde_json::{Value, json};
use support::*;

// ---------- 助手 ----------

impl World {
    /// ARC（ARCHIVED）、TRS（TRASHED，带一条任务）两个项目。
    fn lifecycle_projects(&self) {
        self.exec(&format!(
            "INSERT INTO scope_generations (gen, scope_kind, scope_id, reason, epoch, created_at) VALUES
               (3, 'PROJECT', 'PR', 'CREATED', 'ER', '{T0}'), (4, 'PROJECT', 'PT', 'CREATED', 'ET', '{T0}');
             UPDATE app_meta SET scope_gen_counter = 4;
             INSERT INTO projects (id, code, name, lifecycle, health, meta_version, scope_gen, epoch, created_at, updated_at) VALUES
               ('PR', 'ARC', '归档的', 'ARCHIVED', 'UNKNOWN', 0, 3, 'ER', '{T0}', '{T0}'),
               ('PT', 'TRS', '垃圾箱里的', 'TRASHED', 'UNKNOWN', 0, 4, 'ET', '{T0}', '{T0}');
             INSERT INTO counters (project_id, name, next_value) VALUES
               ('PR', 'work_item', 1), ('PR', 'record', 1), ('PR', 'blocker', 1), ('PR', 'objective', 1), ('PR', 'milestone', 1),
               ('PT', 'work_item', 1), ('PT', 'record', 1);
             INSERT INTO agents (project_id, id, display_name, client_kind, created_at, updated_at)
               VALUES ('PR', 'claude', 'claude', 'cli', '{T0}', '{T0}');
             INSERT INTO agent_sessions (project_id, id, agent_id, role, work_state, connection_state, started_at, updated_at)
               VALUES ('PR', 'SR', 'claude', 'PRIMARY', 'IDLE', 'ONLINE', '{T0}', '{T0}');
             INSERT INTO project_paths (id, project_id, path_key, canonical_path, is_primary, last_seen_at)
               VALUES ('PPT', 'PT', 'r:\\trash', 'R:\\Trash', 1, '{T0}');"
        ));
    }

    fn lifecycle(&self, code: &str) -> String {
        self.scalar(&format!(
            "SELECT lifecycle FROM projects WHERE code = '{code}'"
        ))
        .as_str()
        .unwrap()
        .to_owned()
    }

    fn set(&self, code: &str, t: Transition) -> Result<Written, atm_domain::error::DomainError> {
        let op = self.next_op();
        self.svc.set_lifecycle(&user(), code, t, &op)
    }
}

fn create(name: &str) -> CreateProjectRequest {
    CreateProjectRequest::new(name)
}

fn at(path: &str) -> Option<PathInfo> {
    Some(PathInfo {
        canonical_path: path.into(),
        git_common_dir: None,
    })
}

fn begin_at(agent_id: &str, canonical: &str) -> BeginRequest {
    BeginRequest {
        selector: ProjectSelector {
            path_key: Some(path_key(canonical)),
            canonical_path: Some(canonical.into()),
            ..ProjectSelector::default()
        },
        cwd: Some(canonical.into()),
        ..BeginRequest::new(agent_id)
    }
}

fn count_where(w: &World, table: &str, cond: &str) -> i64 {
    w.count(&format!("SELECT count(*) FROM {table} WHERE {cond}"))
}

// ================= L-001 / L-012：创建 =================

/// L-001：一个事务里写 project、世代、计数器、路径与全局事件，提交后就是 ACTIVE；marker 交给调用方写（C-L03）。
#[test]
fn l001_create_project_in_one_transaction() {
    let w = world("pj-create");
    let r = w
        .svc
        .create_project(
            &user(),
            CreateProjectRequest {
                path: at(r"D:\Work\Alpha\"),
                description: Some("说明".into()),
                ..create("Alpha Service")
            },
        )
        .unwrap();
    let p = &r.result["project"];
    assert_eq!(
        (p["code"].clone(), p["lifecycle"].clone()),
        (json!("AS"), json!("ACTIVE"))
    );
    let id = p["id"].as_str().unwrap();
    assert_eq!(w.lifecycle("AS"), "ACTIVE");
    assert_eq!(
        count_where(&w, "counters", &format!("project_id = '{id}'")),
        7
    );
    assert_eq!(
        w.scalar(&format!(
            "SELECT path_key FROM project_paths WHERE project_id = '{id}'"
        )),
        r"d:\work\alpha"
    );
    assert_eq!(
        w.scalar(&format!(
            "SELECT canonical_path FROM project_paths WHERE project_id = '{id}'"
        )),
        r"D:\Work\Alpha\"
    );
    assert_eq!(
        count_where(
            &w,
            "scope_generations",
            &format!("scope_id = '{id}' AND reason = 'CREATED'")
        ),
        1
    );
    assert_eq!(
        count_where(
            &w,
            "global_feed",
            &format!("type = 'project.created' AND aggregate_id = '{id}' AND actor = 'USER'")
        ),
        1
    );
    assert_eq!(r.result["marker"]["content"]["project_code"], "AS");
    assert_eq!(r.result["marker"]["file"], ".ayanami-task/project.json");
    // 新项目立即可用：读与写都按普通项目走。
    let b = w.svc.brief(&agent(), "as", &Default::default()).unwrap();
    assert_eq!(b["project"], "AS");
}

/// L-012：派生、后缀、显式代码的校验与冲突；L-001 的反例：失败的创建零写入。
#[test]
fn l012_project_codes() {
    let w = world("pj-codes");
    let code = |r: CreateProjectRequest| {
        w.svc.create_project(&user(), r).unwrap().result["project"]["code"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    assert_eq!(code(create("AyanamiTaskManager")), "ATM2");
    assert_eq!(code(create("AyanamiTaskManager")), "ATM3");
    assert_eq!(code(create("项目")), "AYT-0005");
    assert_eq!(
        code(CreateProjectRequest {
            code: Some(" new-x ".into()),
            ..create("x")
        }),
        "NEW-X"
    );
    for (bad, want) in [
        ("1AB", ErrorCode::INVALID_PROJECT_CODE),
        ("A", ErrorCode::INVALID_PROJECT_CODE),
        ("atm", ErrorCode::PROJECT_CODE_CONFLICT),
    ] {
        w.refused(want, || {
            w.svc.create_project(
                &user(),
                CreateProjectRequest {
                    code: Some(bad.into()),
                    ..create("x")
                },
            )
        });
    }
}

/// 10 A3：project.create 的落点由服务端决定，走调用索引；同一个 op_id 重放、换内容冲突。
#[test]
fn a3_create_project_is_idempotent_by_op_id() {
    let w = world("pj-create-op");
    let req = || CreateProjectRequest {
        op_id: Some("mk-1".into()),
        path: at(r"D:\Beta"),
        ..create("Beta")
    };
    let first = w.svc.create_project(&user(), req()).unwrap();
    let again = w.svc.create_project(&user(), req()).unwrap();
    assert!(again.replayed);
    assert_eq!(again.result, first.result);
    assert_eq!(count_where(&w, "projects", "name = 'Beta'"), 1);
    let e = w.refused(ErrorCode::IDEMPOTENCY_CONFLICT, || {
        w.svc.create_project(
            &user(),
            CreateProjectRequest {
                name: "Gamma".into(),
                ..req()
            },
        )
    });
    assert_eq!(e.details["op_id"], "mk-1");
    // 调用索引按 principal 划分：Agent 用同一个 op_id 是另一件事。
    let other = w
        .svc
        .create_project(
            &agent(),
            CreateProjectRequest {
                actor: Some("codex".into()),
                path: at(r"D:\Delta"),
                ..create("Delta")
            }
            .with_op("mk-1"),
        )
        .unwrap();
    assert!(!other.replayed);
    assert_eq!(
        w.scalar("SELECT call_principal_kind || ':' || call_principal_id FROM idempotency_receipts WHERE op_id = 'mk-1' AND call_principal_kind = 'AGENT'"),
        "AGENT:codex"
    );
    // 没有 op_id：每次都是新项目。
    w.svc.create_project(&user(), create("NoOp")).unwrap();
    w.svc.create_project(&user(), create("NoOp")).unwrap();
    assert_eq!(count_where(&w, "projects", "name = 'NoOp'"), 2);
}

trait WithOp {
    fn with_op(self, op: &str) -> Self;
}

impl WithOp for CreateProjectRequest {
    fn with_op(mut self, op: &str) -> Self {
        self.op_id = Some(op.into());
        self
    }
}

// ================= L-009 / L-010：路径 =================

/// L-009：路径唯一键按大小写与末尾分隔符折叠；已被认领（含垃圾箱项目）不能建项目，也不能登记给别的项目。
#[test]
fn l009_canonical_paths_are_unique() {
    let w = world("pj-paths");
    w.lifecycle_projects();
    w.svc
        .create_project(
            &user(),
            CreateProjectRequest {
                path: at(r"R:\A\Proj"),
                ..create("Proj")
            },
        )
        .unwrap();
    // 大小写或末尾分隔符不同：认出同一个项目。
    let r = w
        .svc
        .begin(&agent(), begin_at("claude", r"r:\a\PROJ\"))
        .unwrap();
    assert_eq!(r.result["project"]["code"], "PROJ");
    for dir in [r"r:\a\proj\", r"R:\Trash"] {
        let e = w.refused(ErrorCode::PROJECT_ALREADY_EXISTS, || {
            w.svc.create_project(
                &user(),
                CreateProjectRequest {
                    path: at(dir),
                    ..create("Dup")
                },
            )
        });
        assert!(e.details["project"].is_string());
    }
    // 登记给另一个项目：PROJECT_PATH_CONFLICT。
    let op = w.next_op();
    w.refused(ErrorCode::PROJECT_PATH_CONFLICT, || {
        w.svc.attach_path(
            &user(),
            "ATM",
            PathInfo {
                canonical_path: r"R:\a\proj".into(),
                git_common_dir: None,
            },
            true,
            &op,
        )
    });
}

/// L-009 / L-010：登记路径（User）；primary 切换；经 git common dir 认领的仓库也算冲突；Agent 不能登记。
#[test]
fn l010_attach_path() {
    let w = world("pj-attach");
    let attach = |project: &str, path: &str, common: Option<&str>, primary: bool| {
        let op = w.next_op();
        w.svc.attach_path(
            &user(),
            project,
            PathInfo {
                canonical_path: path.into(),
                git_common_dir: common.map(str::to_owned),
            },
            primary,
            &op,
        )
    };
    attach("ATM", r"R:\repo", Some(r"r:\repo\.git"), true).unwrap();
    let r = attach("ATM", r"R:\repo-wt", Some(r"r:\repo\.git"), true).unwrap();
    assert_eq!(r.result["marker"]["content"]["project_code"], "ATM");
    assert_eq!(
        w.count("SELECT count(*) FROM project_paths WHERE project_id = 'PA' AND is_primary = 1"),
        1
    );
    assert_eq!(
        w.scalar("SELECT is_primary FROM project_paths WHERE path_key = 'r:\\repo-wt'"),
        1
    );
    // 同一个仓库的另一个 worktree 登记给别的项目：冲突。
    w.refused(ErrorCode::PROJECT_PATH_CONFLICT, || {
        attach("EMP", r"R:\repo-other", Some(r"r:\repo\.git"), false)
    });
    // 经 git common dir 认出同一个项目（begin）。
    let r = w
        .svc
        .begin(
            &agent(),
            BeginRequest {
                selector: ProjectSelector {
                    git_common_dir: Some(r"r:\repo\.git".into()),
                    ..ProjectSelector::default()
                },
                ..BeginRequest::new("claude")
            },
        )
        .unwrap();
    assert_eq!(r.result["project"]["code"], "ATM");
    let op = w.next_op();
    w.refused(ErrorCode::USER_AUTHORIZATION_REQUIRED, || {
        w.svc.attach_path(
            &agent(),
            "ATM",
            PathInfo {
                canonical_path: r"R:\x".into(),
                git_common_dir: None,
            },
            false,
            &op,
        )
    });
}

// ================= L-002 / L-006 / L-007：生命周期 =================

/// L-002：归档前先做 PRE_ARCHIVE 备份；version+1、事件 actor USER；已经在目标上的不做备份、幂等返回。
#[test]
fn l002_archive_and_unarchive() {
    let w = world("pj-archive");
    let r = w.set("ATM", Transition::Archive).unwrap();
    assert_eq!(r.result["changed"], true);
    let backup = r.result["backupId"].as_str().unwrap().to_owned();
    assert_eq!(
        w.scalar(&format!("SELECT kind FROM backups WHERE id = '{backup}'")),
        "PRE_ARCHIVE"
    );
    assert_eq!(w.lifecycle("ATM"), "ARCHIVED");
    assert_eq!(r.result["project"]["version"], 1);
    assert_eq!(
        count_where(
            &w,
            "global_feed",
            "type = 'project.archived' AND actor = 'USER' AND aggregate_id = 'PA'"
        ),
        1
    );
    let again = w.set("ATM", Transition::Archive).unwrap();
    assert_eq!(
        (
            again.result["changed"].clone(),
            again.result["backupId"].clone()
        ),
        (json!(false), Value::Null)
    );
    assert_eq!(w.count("SELECT count(*) FROM backups"), 1);
    // ARCHIVED 保持可写（L-008）：Agent 照样建任务。
    w.task("归档后照样写");
    let r = w.set("ATM", Transition::Unarchive).unwrap();
    assert_eq!(r.result["project"]["lifecycle"], "ACTIVE");
    assert_eq!(
        count_where(
            &w,
            "global_feed",
            "type = 'project.restored' AND aggregate_id = 'PA'"
        ),
        1
    );
}

/// L-002 反例：Agent 调用一律 403 且零写入；从 TRASHED 归档是 PROJECT_LIFECYCLE_CONFLICT（不是 2.x 的 503）；
/// 备份失败时生命周期不变。
#[test]
fn l002_refusals() {
    let w = world("pj-lifecycle-refused");
    w.lifecycle_projects();
    for t in [
        Transition::Archive,
        Transition::Unarchive,
        Transition::Trash,
        Transition::Untrash,
    ] {
        let op = w.next_op();
        w.refused(ErrorCode::USER_AUTHORIZATION_REQUIRED, || {
            w.svc.set_lifecycle(&agent(), "ATM", t, &op)
        });
    }
    let e = w.refused(ErrorCode::PROJECT_LIFECYCLE_CONFLICT, || {
        w.set("TRS", Transition::Archive)
    });
    assert_eq!(e.details["lifecycle"], "TRASHED");
    w.refused(ErrorCode::PROJECT_LIFECYCLE_CONFLICT, || {
        w.set("TRS", Transition::Unarchive)
    });
    w.refused(ErrorCode::PROJECT_LIFECYCLE_CONFLICT, || {
        w.set("ARC", Transition::Untrash)
    });
    // 备份目录是个文件：备份做不成，生命周期不变，没有备份行，也没有事件。
    let blocker = test_root().join("pj-backup-root-is-a-file");
    std::fs::create_dir_all(blocker.parent().unwrap()).unwrap();
    std::fs::write(&blocker, b"not a directory").unwrap();
    let broken = world_full("pj-lifecycle-broken", None, Some(blocker));
    let e = broken.refused(ErrorCode::INTERNAL_ERROR, || {
        broken.set("ATM", Transition::Archive)
    });
    assert_eq!(e.details["backup_kind"], "PRE_ARCHIVE");
    assert_eq!(broken.lifecycle("ATM"), "ACTIVE");
}

/// L-007 + L-006：进垃圾箱前 PRE_TRASH；内容一行不删；untrash 结掉挂着的 PENDING 并恢复原样。
#[test]
fn l006_l007_trash_and_untrash() {
    let w = world("pj-trash");
    let k = w.task("一");
    let before = w.snapshot();
    let rows = |snap: &Vec<(String, Vec<String>)>, table: &str| {
        snap.iter().find(|(n, _)| n == table).unwrap().1.len()
    };
    let r = w.set("ATM", Transition::Trash).unwrap();
    assert_eq!(
        w.scalar(&format!(
            "SELECT kind FROM backups WHERE id = '{}'",
            r.result["backupId"].as_str().unwrap()
        )),
        "PRE_TRASH"
    );
    assert_eq!(w.lifecycle("ATM"), "TRASHED");
    let after = w.snapshot();
    for table in [
        "work_items",
        "events",
        "records",
        "agent_sessions",
        "counters",
    ] {
        assert_eq!(rows(&before, table), rows(&after, table), "{table}");
    }
    // 再 trash：幂等，不再备份。
    assert_eq!(
        w.set("ATM", Transition::Trash).unwrap().result["changed"],
        false
    );
    assert_eq!(w.count("SELECT count(*) FROM backups"), 1);
    // Agent begin 撞上 → 登记恢复请求；User 直接 untrash → 请求 APPROVED。
    w.svc
        .begin(
            &agent(),
            BeginRequest {
                selector: ProjectSelector {
                    code: Some("ATM".into()),
                    ..ProjectSelector::default()
                },
                ..BeginRequest::new("claude")
            },
        )
        .unwrap_err();
    let r = w.set("ATM", Transition::Untrash).unwrap();
    assert_eq!(r.result["project"]["lifecycle"], "ACTIVE");
    assert_eq!(r.result["restoreRequest"]["status"], "APPROVED");
    assert_eq!(r.result["restoreRequest"]["decidedBy"], "USER");
    assert_eq!(
        w.count("SELECT count(*) FROM project_restore_requests WHERE status = 'PENDING'"),
        0
    );
    assert_eq!(status(&w, &k), "READY");
}

// ================= L-003 / L-004 / L-005：恢复请求 =================

/// L-003 + L-004：撞上垃圾箱项目只登记恢复请求；quick、建项目、op_id 都不能绕过；重复撞上只累加次数、事件只记一条，
/// 请求者与来源目录是最后一次的值。
#[test]
fn l003_l004_trashed_begin_registers_a_restore_request() {
    let w = world("pj-trashed-begin");
    w.lifecycle_projects();
    let hit = |agent_id: &str, cwd: &str, quick: bool| {
        w.svc
            .begin(
                &agent(),
                BeginRequest {
                    mode: quick.then(|| "quick".into()),
                    allow_project_create: true,
                    op_id: Some(w.next_op()),
                    ..begin_at(agent_id, cwd)
                },
            )
            .unwrap_err()
    };
    let e = hit("claude", r"R:\Trash", true);
    assert_eq!(e.code, ErrorCode::PROJECT_DB_UNAVAILABLE);
    assert_eq!(e.details["retryable"], false);
    assert_eq!(
        e.details["recovery"]["action"],
        "await_user_restore_authorization"
    );
    assert_eq!(e.details["quick"]["action"], "do_not_bypass");
    let e = hit("codex", r"r:\TRASH\", false);
    assert_eq!(e.details["recovery"]["request_count"], 2);
    // 落库的计数与回给 Agent 的一致（不只是返回值算对）。
    assert_eq!(
        w.count("SELECT request_count FROM project_restore_requests"),
        2
    );
    assert_eq!(
        w.scalar("SELECT requested_by || '|' || source_cwd FROM project_restore_requests"),
        r"codex|r:\TRASH\"
    );
    assert_eq!(
        count_where(&w, "global_feed", "type = 'project.restore_requested'"),
        1
    );
    assert_eq!(w.count("SELECT count(*) FROM quick_tasks"), 0);
    assert_eq!(w.count("SELECT count(*) FROM projects"), 4);
    assert_eq!(count_where(&w, "agent_sessions", "project_id = 'PT'"), 0);
    assert_eq!(
        count_where(&w, "idempotency_receipts", "call_operation IS NOT NULL"),
        0
    );
    assert_eq!(w.lifecycle("TRS"), "TRASHED");
}

/// L-005：只能决定一次；批准与恢复在同一事务；拒绝留在垃圾箱；不存在的请求 404；Agent 403。
#[test]
fn l005_restore_requests_are_decided_once() {
    let w = world("pj-decide");
    w.lifecycle_projects();
    let request = || {
        w.svc
            .begin(&agent(), begin_at("claude", r"R:\Trash"))
            .unwrap_err()
            .details["recovery"]["request_id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let id = request();
    let decide = |id: &str, approve: bool| {
        let op = w.next_op();
        w.svc.decide_restore_request(&user(), id, approve, &op)
    };
    w.refused(ErrorCode::USER_AUTHORIZATION_REQUIRED, || {
        let op = w.next_op();
        w.svc.decide_restore_request(&agent(), &id, true, &op)
    });
    let r = decide(&id, false).unwrap();
    assert_eq!(r.result["request"]["status"], "REJECTED");
    assert_eq!(w.lifecycle("TRS"), "TRASHED");
    assert_eq!(
        count_where(&w, "global_feed", "type = 'project.restore_rejected'"),
        1
    );
    let e = w.refused(ErrorCode::PROJECT_RESTORE_REQUEST_DECIDED, || {
        decide(&id, true)
    });
    assert_eq!(e.details["status"], "REJECTED");
    // 再撞一次 → 新的一条 PENDING；批准 → 同一事务里恢复 ACTIVE。
    let id2 = request();
    assert_ne!(id2, id);
    let r = decide(&id2, true).unwrap();
    assert_eq!(r.result["request"]["status"], "APPROVED");
    assert_eq!(r.result["request"]["decidedBy"], "USER");
    assert_eq!(r.result["project"]["lifecycle"], "ACTIVE");
    assert_eq!(
        count_where(
            &w,
            "global_feed",
            "type = 'project.restored' AND aggregate_id = 'PT'"
        ),
        1
    );
    let e = decide("NOPE", true).unwrap_err();
    assert_eq!(e.code, ErrorCode::PROJECT_RESTORE_REQUEST_NOT_FOUND);
}

// ================= L-008：各状态能做什么 =================

/// L-008：垃圾箱项目的内容不可写（Agent、User 都一样），已提交的请求照样重放；注册信息照样可读；
/// ARCHIVED 的 Agent begin 与 claim 照常。
#[test]
fn l008_what_each_state_allows() {
    let w = world("pj-l008");
    w.lifecycle_projects();
    let k = w.task("一");
    let t = Target::new("PA", Some("S1"), "op-before-trash");
    let original = w
        .svc
        .patch_work_items(&agent(), &t, vec![p(&k, Operation::Claim)])
        .unwrap();
    w.set("ATM", Transition::Trash).unwrap();
    let e = w.refused(ErrorCode::PROJECT_DB_UNAVAILABLE, || {
        w.create_as(&agent(), Some("S1"), vec![item("垃圾箱里")])
    });
    assert_eq!(e.details["retryable"], false);
    w.refused(ErrorCode::PROJECT_DB_UNAVAILABLE, || {
        w.create_as(&user(), None, vec![item("用户也不行")])
    });
    // 不经过工作项层的写入也由写入流水线拒绝（收工不例外）。
    w.refused(ErrorCode::PROJECT_DB_UNAVAILABLE, || {
        w.svc.end_session(
            &agent(),
            &Target::new("PA", Some("S1"), "end-in-trash"),
            EndRequest {
                outcome: Outcome::Paused,
                summary: "收工".into(),
                next: Vec::new(),
                release_claims: false,
                retirement_reason: None,
                git: None,
            },
        )
    });
    let replay = w
        .svc
        .patch_work_items(&agent(), &t, vec![p(&k, Operation::Claim)])
        .unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.result, original.result);
    let info = w.svc.project_info(&agent(), "atm").unwrap();
    assert_eq!(info["lifecycle"], "TRASHED");
    let trash = w.svc.trash(&user()).unwrap();
    let codes: Vec<&str> = trash["projects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["code"].as_str().unwrap())
        .collect();
    assert_eq!(codes.len(), 2);
    assert!(codes.contains(&"ATM") && codes.contains(&"TRS"));
    // ARCHIVED：Agent begin 并写任务，生命周期不变。
    let r = w
        .svc
        .begin(
            &agent(),
            BeginRequest {
                selector: ProjectSelector {
                    code: Some("ARC".into()),
                    ..ProjectSelector::default()
                },
                mode: Some("quick".into()),
                ..BeginRequest::new("claude")
            },
        )
        .unwrap();
    assert_eq!(r.result["project"]["lifecycle"], "ARCHIVED");
    let sid = r.result["session"]["id"].as_str().unwrap().to_owned();
    w.svc
        .create_work_items(
            &agent(),
            &Target::new("PR", Some(&sid), "arc-1"),
            vec![atm_service::work::CreateItem {
                title: "归档里也能写".into(),
                ..atm_service::work::CreateItem::default()
            }],
        )
        .unwrap();
    assert_eq!(w.lifecycle("ARC"), "ARCHIVED");
}

// ================= 10 A3 ③④⑤：没有匹配到项目的 begin =================

/// ③：显式 quick 先于建项目；op_id 重试拿到同一个 Q 键（03 C-11）；不建项目、不建 session。
#[test]
fn a3_begin_quick_branch() {
    let w = world("pj-begin-quick");
    let quick = |op: &str| {
        w.svc
            .begin(
                &agent(),
                BeginRequest {
                    mode: Some("quick".into()),
                    allow_project_create: true,
                    title: Some("顺手修个拼写".into()),
                    op_id: Some(op.into()),
                    ..begin_at("claude", r"D:\scratch")
                },
            )
            .unwrap()
    };
    let first = quick("q-1");
    assert_eq!(first.result["scope"], "quick");
    assert_eq!(first.result["quick"]["key"], "Q-0001");
    assert_eq!(first.result["quick"]["title"], "顺手修个拼写");
    assert_eq!(first.result["session"], Value::Null);
    let again = quick("q-1");
    assert!(again.replayed);
    assert_eq!(again.result["quick"]["key"], "Q-0001");
    assert_eq!(quick("q-2").result["quick"]["key"], "Q-0002");
    assert_eq!(w.count("SELECT count(*) FROM quick_tasks"), 2);
    assert_eq!(w.count("SELECT count(*) FROM projects"), 2);
    assert_eq!(
        w.scalar("SELECT scope_kind || '|' || COALESCE(scope_generation, 'null') FROM idempotency_receipts WHERE op_id = 'q-1'"),
        "GLOBAL|null"
    );
    assert_eq!(
        count_where(
            &w,
            "global_feed",
            "type = 'quick.created' AND actor = 'claude'"
        ),
        2
    );
    let brief = w
        .svc
        .begin_brief(&agent(), &first, atm_service::read::BeginBrief::Full, 1200)
        .unwrap();
    assert_eq!(
        (brief["scope"].clone(), brief["quick"]["key"].clone()),
        (json!("quick"), json!("Q-0001"))
    );
}

/// ④：允许建项目时，在同一个写事务里建项目并建 session；重放拿回同一个结果；名字取 title 或目录名。
#[test]
fn a3_begin_create_branch() {
    let w = world("pj-begin-create");
    let req = || BeginRequest {
        allow_project_create: true,
        op_id: Some("c-1".into()),
        creation_reason: Some("首次在这个仓库里工作".into()),
        ..begin_at("claude", r"D:\Repos\Shiny Widget\")
    };
    let r = w.svc.begin(&agent(), req()).unwrap();
    assert_eq!(r.result["projectCreated"], true);
    assert_eq!(r.result["project"]["name"], "Shiny Widget");
    assert_eq!(r.result["project"]["code"], "SW");
    assert_eq!(r.result["outcome"], "CREATED");
    assert_eq!(r.result["marker"]["directory"], r"D:\Repos\Shiny Widget\");
    let id = r.result["project"]["id"].as_str().unwrap().to_owned();
    assert_eq!(
        count_where(&w, "agent_sessions", &format!("project_id = '{id}'")),
        1
    );
    let generation: i64 = w
        .scalar(&format!("SELECT scope_gen FROM projects WHERE id = '{id}'"))
        .as_i64()
        .unwrap();
    assert_eq!(
        w.scalar("SELECT scope_kind || '|' || scope_generation FROM idempotency_receipts WHERE op_id = 'c-1'"),
        format!("PROJECT|{generation}")
    );
    let again = w.svc.begin(&agent(), req()).unwrap();
    assert!(again.replayed);
    assert_eq!(again.result["project"]["id"], id.as_str());
    assert_eq!(count_where(&w, "projects", "name = 'Shiny Widget'"), 1);
    // 已经建好：之后的 begin 经路径认出它，不再建。
    let r = w
        .svc
        .begin(
            &agent(),
            BeginRequest {
                allow_project_create: true,
                ..begin_at("codex", r"d:\repos\shiny widget")
            },
        )
        .unwrap();
    assert_eq!(r.result["project"]["id"], id.as_str());
    assert!(r.result.get("projectCreated").is_none());
    // 桥 resolve 时记下的世代对新建的项目没有意义（A3：CREATE 没有可比的世代），不拿它拦。
    let r = w
        .svc
        .begin(
            &agent(),
            BeginRequest {
                allow_project_create: true,
                expected_generation: Some(999),
                ..begin_at("claude", r"D:\Repos\Other")
            },
        )
        .unwrap();
    assert_eq!(r.result["projectCreated"], true);
}

/// ⑤：不 quick、也不允许建项目 → PROJECT_REQUIRED，零写入；mode 只认 auto / project / quick。
#[test]
fn a3_begin_without_a_project() {
    let w = world("pj-begin-none");
    let e = w.refused(ErrorCode::PROJECT_REQUIRED, || {
        w.svc.begin(
            &agent(),
            BeginRequest {
                mode: Some("project".into()),
                op_id: Some("n-1".into()),
                ..begin_at("claude", r"D:\nowhere")
            },
        )
    });
    assert_eq!(e.details["next"]["allow_project_create"], true);
    w.refused(ErrorCode::INVALID_ARGUMENT, || {
        w.svc.begin(
            &agent(),
            BeginRequest {
                mode: Some("weird".into()),
                ..begin_at("claude", r"D:\nowhere")
            },
        )
    });
}

/// L-001 反例：建项目的事务中途失败（这里用触发器在写 scope 世代时注入），项目、路径、计数器、事件一条都不留，
/// 全局序号不前进；去掉故障后同名再建成功。
#[test]
fn l001_a_failure_inside_create_leaves_nothing() {
    let w = world("pj-create-fault");
    w.exec(
        "CREATE TRIGGER inject_create_fault BEFORE INSERT ON scope_generations
         BEGIN SELECT RAISE(ABORT, 'injected create fault'); END;",
    );
    let e = w.refused(ErrorCode::INTERNAL_ERROR, || {
        w.svc.create_project(
            &user(),
            CreateProjectRequest {
                path: at(r"D:\Work\Beta\"),
                ..create("Beta")
            },
        )
    });
    assert!(e.message.contains("injected"), "{e:?}");
    w.exec("DROP TRIGGER inject_create_fault;");
    let r = w
        .svc
        .create_project(
            &user(),
            CreateProjectRequest {
                path: at(r"D:\Work\Beta\"),
                ..create("Beta")
            },
        )
        .unwrap();
    let code = r.result["project"]["code"].as_str().unwrap().to_owned();
    assert_eq!(w.lifecycle(&code), "ACTIVE");
}

/// L-004 反例：同一项目同时只能有一条 PENDING 恢复请求（部分唯一索引兜底，并发撞上也只累加那一条）；
/// 已决定的请求不受限制。
#[test]
fn l004_one_pending_restore_request_per_project() {
    let w = world("pj-one-pending");
    let row = |id: &str, status: &str| {
        let decided = if status == "PENDING" {
            "NULL, NULL"
        } else {
            "'2026-10-05T00:00:00.000Z', 'USER'"
        };
        format!(
            "INSERT INTO project_restore_requests (id, project_id, requested_by, status, created_at, updated_at, decided_at, decided_by)
               VALUES ('{id}', 'PA', 'claude', '{status}', '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z', {decided})"
        )
    };
    w.exec(&row("r1", "PENDING"));
    let second = w.svc.store().write({
        let sql = row("r2", "PENDING");
        move |tx| tx.execute_batch(&sql)
    });
    assert!(second.is_err(), "a second PENDING request was accepted");
    w.exec(&row("r3", "APPROVED"));
    assert_eq!(
        w.count("SELECT count(*) FROM project_restore_requests WHERE project_id = 'PA'"),
        2
    );
}

fn backup_dirs(w: &World) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(w.dir.join("backups"))
        .map(|d| {
            d.map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

/// peer W2 r1 P1-02：PRE_* 备份不早于幂等裁决。状态已经变过之后原样重发旧的 archive / trash 是重放，
/// 拿已用于 unarchive / untrash 的 op_id 调 archive / trash 是冲突——两者整库与备份目录都零变化。
#[test]
fn l002_lifecycle_replays_and_conflicts_make_no_backups() {
    let w = world("pj-lifecycle-replay");
    for (forward, back) in [
        (Transition::Archive, Transition::Unarchive),
        (Transition::Trash, Transition::Untrash),
    ] {
        let (f, b) = (w.next_op(), w.next_op());
        let first = w.svc.set_lifecycle(&user(), "ATM", forward, &f).unwrap();
        assert!(first.result["backupId"].is_string());
        w.svc.set_lifecycle(&user(), "ATM", back, &b).unwrap();
        assert_eq!(w.lifecycle("ATM"), "ACTIVE");
        let (db, files) = (w.snapshot(), backup_dirs(&w));
        let again = w.svc.set_lifecycle(&user(), "ATM", forward, &f).unwrap();
        assert!(again.replayed);
        assert_eq!(again.result, first.result);
        assert_eq!((w.snapshot(), backup_dirs(&w)), (db.clone(), files.clone()));
        w.refused(ErrorCode::IDEMPOTENCY_CONFLICT, || {
            w.svc.set_lifecycle(&user(), "ATM", forward, &b)
        });
        assert_eq!(backup_dirs(&w), files);
    }
    assert_eq!(w.count("SELECT count(*) FROM backups"), 2);
}

/// 同一 World，换上「备份做完后先让别人改一下项目」的钩子（只在第一次备份后改）。返回做了几次备份。
fn racing(
    name: &str,
    sql: &'static str,
) -> (World, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
    let World { svc, op, dir } = world(name);
    let db = dir.join("atm.sqlite");
    let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let seen = calls.clone();
    let hook = move || {
        if seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
            let c = rusqlite::Connection::open(&db).unwrap();
            c.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
            c.execute_batch(sql).unwrap();
        }
    };
    let w = World {
        svc: svc.with_backup_hook(std::sync::Arc::new(hook)),
        op,
        dir,
    };
    (w, calls)
}

/// peer W2 r1 P1-02：备份做完、迁移提交之前被并发迁移抢先。项目版本变了 → 撤回旧备份、按新状态重做一份；
/// 抢先者已经把项目归档了 → 这次没有迁移，备份撤回，行与目录都不留。
#[test]
fn l002_a_backup_overtaken_by_another_writer_is_withdrawn() {
    let (w, backups) = racing(
        "pj-lifecycle-race-version",
        "UPDATE projects SET version = version + 1 WHERE id = 'PA'",
    );
    let r = w.set("ATM", Transition::Archive).unwrap();
    // 备份做了两次：第一份基于旧版本，撤回；第二份基于抢先之后的状态，留下。
    assert_eq!(backups.load(std::sync::atomic::Ordering::SeqCst), 2);
    let id = r.result["backupId"].as_str().unwrap().to_owned();
    assert_eq!(backup_dirs(&w), vec![id.clone()]);
    assert_eq!(w.scalar("SELECT group_concat(id) FROM backups"), json!(id));
    assert_eq!(r.result["project"]["version"], 2);

    let (w, backups) = racing(
        "pj-lifecycle-race-done",
        "UPDATE projects SET lifecycle = 'ARCHIVED', version = version + 1 WHERE id = 'PA'",
    );
    let r = w.set("ATM", Transition::Archive).unwrap();
    assert_eq!(
        (r.result["changed"].clone(), r.result["backupId"].clone()),
        (json!(false), Value::Null)
    );
    assert_eq!(w.count("SELECT count(*) FROM backups"), 0);
    assert!(backup_dirs(&w).is_empty());
    assert_eq!(backups.load(std::sync::atomic::Ordering::SeqCst), 1);
}

/// peer W2 r1 P1-02：两个线程同时用同一个 op_id 归档——一个迁移、一个重放，只留一份备份。
#[test]
fn l002_concurrent_archives_keep_one_backup() {
    let w = world("pj-lifecycle-concurrent");
    let results: Vec<Written> = std::thread::scope(|s| {
        let a = s.spawn(|| {
            w.svc
                .set_lifecycle(&user(), "ATM", Transition::Archive, "same")
                .unwrap()
        });
        let b = s.spawn(|| {
            w.svc
                .set_lifecycle(&user(), "ATM", Transition::Archive, "same")
                .unwrap()
        });
        vec![a.join().unwrap(), b.join().unwrap()]
    });
    assert_eq!(results[0].result, results[1].result);
    assert_eq!(results.iter().filter(|r| r.replayed).count(), 1);
    assert_eq!(w.count("SELECT count(*) FROM backups"), 1);
    assert_eq!(backup_dirs(&w).len(), 1);
}

/// 钩子经弱引用拿到同一个 Service：模拟两趟之间同一进程里的另一个调用（恢复、同 op 归档）。只在第一次备份后触发。
fn hooked(
    name: &str,
    hook: impl Fn(&Service, &std::path::Path) + Send + Sync + 'static,
) -> (std::sync::Arc<Service>, std::path::PathBuf) {
    let World { svc, dir, .. } = world(name);
    let (d, once) = (dir.clone(), std::sync::atomic::AtomicBool::new(true));
    let svc = std::sync::Arc::new_cyclic(|weak: &std::sync::Weak<Service>| {
        let weak = weak.clone();
        svc.with_backup_hook(std::sync::Arc::new(move || {
            if once.swap(false, std::sync::atomic::Ordering::SeqCst) {
                hook(&weak.upgrade().unwrap(), &d);
            }
        }))
    });
    (svc, dir)
}

fn query(svc: &Service, sql: &str) -> Value {
    let sql = sql.to_owned();
    let v: rusqlite::types::Value = svc
        .store()
        .read(move |tx| tx.query_row(&sql, [], |r| r.get(0)))
        .unwrap();
    match v {
        rusqlite::types::Value::Integer(n) => json!(n),
        rusqlite::types::Value::Text(t) => json!(t),
        _ => Value::Null,
    }
}

fn dirs_in(dir: &std::path::Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir.join("backups"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn rows_in(svc: &Service) -> Vec<String> {
    let mut ids: Vec<String> = svc
        .store()
        .read(|tx| {
            tx.prepare("SELECT id FROM backups")?
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()
        })
        .unwrap();
    ids.sort();
    ids
}

/// peer W2 r2 P1-01：PRE_ARCHIVE 做完、第二趟之前项目被恢复。第二趟带着进来时的世代，报 SCOPE_RESTORED，
/// 不采纳恢复后的世代继续迁移：项目仍是 ACTIVE，这个 op 没有回执、没有事件，没用上的 PRE_ARCHIVE 撤回。
#[test]
fn l002_a_restore_between_passes_is_scope_restored() {
    let (svc, dir) = hooked("pj-lifecycle-restored", |other, _| {
        let id = other.create_manual_backup(&user()).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        other
            .restore_scope(&user(), &id, RestoreScope::Project("ATM".into()))
            .unwrap();
    });
    let before = query(&svc, "SELECT scope_gen FROM projects WHERE id = 'PA'");
    let e = svc
        .set_lifecycle(&user(), "ATM", Transition::Archive, "old-queue")
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::SCOPE_RESTORED, "{e:?}");
    assert_eq!(e.details["expected_generation"], before);
    assert_eq!(
        e.details["current_generation"],
        query(&svc, "SELECT scope_gen FROM projects WHERE id = 'PA'")
    );
    assert_ne!(e.details["current_generation"], before);
    assert_eq!(
        query(&svc, "SELECT lifecycle FROM projects WHERE id = 'PA'"),
        "ACTIVE"
    );
    for sql in [
        "SELECT count(*) FROM idempotency_receipts WHERE op_id = 'old-queue'",
        "SELECT count(*) FROM events WHERE op_id = 'old-queue'",
        "SELECT count(*) FROM events WHERE type = 'project.archived'",
        "SELECT count(*) FROM backups WHERE kind = 'PRE_ARCHIVE'",
    ] {
        assert_eq!(query(&svc, sql), 0, "{sql}");
    }
    assert_eq!(dirs_in(&dir), rows_in(&svc));
}

/// 对照：恢复也挡不住已经提交的同一个 op 的裁决。两趟之间同 op 的归档先成功，再恢复到它之后的备份
/// （回执仍有效）→ 第二趟重放；恢复到它之前的备份（回执成了墓碑）→ OPERATION_UNDONE_BY_RESTORE。
#[test]
fn l002_replay_and_undone_outrank_the_generation_barrier() {
    for (after, code) in [
        (true, None),
        (false, Some(ErrorCode::OPERATION_UNDONE_BY_RESTORE)),
    ] {
        let (svc, dir) = hooked("pj-lifecycle-restored-replay", move |other, _| {
            let early = other.create_manual_backup(&user()).unwrap();
            other
                .set_lifecycle(&user(), "ATM", Transition::Archive, "same-op")
                .unwrap();
            let late = other.create_manual_backup(&user()).unwrap();
            let pick = if after { late } else { early };
            other
                .restore_scope(
                    &user(),
                    pick["id"].as_str().unwrap(),
                    RestoreScope::Project("ATM".into()),
                )
                .unwrap();
        });
        let r = svc.set_lifecycle(&user(), "ATM", Transition::Archive, "same-op");
        match code {
            None => assert!(r.unwrap().replayed),
            Some(code) => assert_eq!(r.unwrap_err().code, code),
        }
        assert_eq!(dirs_in(&dir), rows_in(&svc));
    }
}

/// peer W2 r2 P1-02 反例 A：两趟之间别人选中这份 PRE_ARCHIVE 恢复了（固定、被恢复引用）。
/// 这次迁移没用上它，也不能删：登记行、目录、恢复引用都在。
#[test]
fn l002_withdrawal_keeps_a_backup_a_restore_selected() {
    let picked = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let seen = picked.clone();
    let (svc, dir) = hooked("pj-lifecycle-withdraw-pinned", move |other, _| {
        let id = other.list_backups(&user(), 200).unwrap()["backups"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        other
            .restore_scope(&user(), &id, RestoreScope::Project("ATM".into()))
            .unwrap();
        *seen.lock().unwrap() = id;
    });
    let e = svc
        .set_lifecycle(&user(), "ATM", Transition::Archive, "pin-race")
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::SCOPE_RESTORED);
    let id = picked.lock().unwrap().clone();
    assert_eq!(
        query(
            &svc,
            &format!("SELECT kind FROM backups WHERE id = '{id}' AND pinned_until IS NOT NULL")
        ),
        "PRE_ARCHIVE"
    );
    assert_eq!(
        query(
            &svc,
            &format!("SELECT count(*) FROM scope_generations WHERE backup_id = '{id}'")
        ),
        1
    );
    assert!(dir.join("backups").join(&id).join("atm.sqlite").exists());
    assert_eq!(dirs_in(&dir), rows_in(&svc));
    let list = svc.list_backups(&user(), 200).unwrap();
    assert_eq!(list["withdrawals"]["recent"][0]["id"], json!(id));
    assert_eq!(list["withdrawals"]["recent"][0]["outcome"], "KEPT");
    assert_eq!(list["withdrawals"]["recent"][0]["reason"], "PINNED");
}

/// peer W2 r2 P1-02 反例 B：要撤回的备份文件被占用（Windows 不共享打开）。目录挪不动就整份保留，
/// 不能先删登记行再留下没登记的残留目录；外层照常重放。
#[cfg(windows)]
#[test]
fn l002_withdrawal_that_cannot_move_files_keeps_the_backup_registered() {
    use std::os::windows::fs::OpenOptionsExt;
    let held = std::sync::Arc::new(std::sync::Mutex::new(None));
    let hold = held.clone();
    let (svc, dir) = hooked("pj-lifecycle-withdraw-locked", move |other, dir| {
        let id = rows_in(other).pop().unwrap();
        let file = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(dir.join("backups").join(id).join("atm.sqlite"))
            .unwrap();
        *hold.lock().unwrap() = Some(file);
        other
            .set_lifecycle(&user(), "ATM", Transition::Archive, "same-op")
            .unwrap();
    });
    let r = svc
        .set_lifecycle(&user(), "ATM", Transition::Archive, "same-op")
        .unwrap();
    assert!(r.replayed);
    drop(held.lock().unwrap().take());
    assert_eq!(rows_in(&svc).len(), 2);
    assert_eq!(dirs_in(&dir), rows_in(&svc));
    let list = svc.list_backups(&user(), 200).unwrap();
    assert_eq!(list["withdrawals"]["recent"][0]["reason"], "FILES_IN_USE");
    assert_eq!(list["withdrawals"]["cleanupPending"], 0);
}

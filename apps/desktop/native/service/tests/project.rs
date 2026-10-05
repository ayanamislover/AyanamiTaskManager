//! 项目生命周期、路径与 begin ③④⑤ 的验收（W2g1；04 L-001～L-012，D32、D33；10 A3；03 C-11）。

mod support;

use atm_domain::error::ErrorCode;
use atm_domain::work::Operation;
use atm_service::project::{CreateProjectRequest, PathInfo, Transition};
use atm_service::session::{BeginRequest, EndRequest, Outcome, ProjectSelector};
use atm_service::work::Target;
use atm_service::write::Written;
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
    let blocker = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("target")
        .join("service-tests")
        .join("pj-backup-root-is-a-file");
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

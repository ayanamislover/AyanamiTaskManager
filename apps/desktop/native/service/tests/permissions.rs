//! 服务层权限矩阵的 Agent 拒绝用例（W2h1；03 §3、§5，P-004、P-005；D31）。
//!
//! 每个已在服务层实现的 U-only 能力：Agent 调用报 `USER_AUTHORIZATION_REQUIRED`，并按 03 §5.1 检查无副作用：
//! NS-1（整库逐表，含 FTS 影子表、回执、事件）、NS-2（各种序号与世代都在表里，随 NS-1 一起比）、
//! NS-3 / NS-4（数据根下除库文件外的文件集合与内容，含备份目录：没有 PRE_* 备份、没有修剪）。
//! 子进程、网络、配置文件、宿主状态（NS-5～NS-9）在服务层没有通道，随 W4/W5 的入口一起验。
//!
//! 阳性对照：同一组调用换成 User，逐条留下可见写入，证明指纹不是空转。

mod support;

use atm_domain::error::{DomainError, ErrorCode};
use atm_domain::principal::Principal;
use atm_service::knowledge::{ArchiveRequest, Content, UserSave};
use atm_service::project::{PathInfo, Transition};
use atm_service::session::GitContext;
use atm_service::settings::BackupPolicy;
use atm_service::views::{SavedViewCreate, SavedViewUpdate};
use atm_service::work::Target;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::Path;
use support::*;

/// 数据根下除库文件（`atm.sqlite*`）外的文件：相对路径 → 内容（NS-3、NS-4）。
fn files(root: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(root, &p, out);
            } else {
                let rel = p
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                if !rel.starts_with("atm.sqlite") {
                    out.insert(rel, std::fs::read(&p).unwrap_or_default());
                }
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

/// 一个 U-only 入口：Agent 调用被拒且整库、文件都不变；返回 User 的同一调用。
type Call = Box<dyn Fn(&World, &Principal, &str) -> Result<Value, DomainError>>;

struct Case {
    name: &'static str,
    call: Call,
}

fn case<T: Into<Value>>(
    name: &'static str,
    f: impl Fn(&World, &Principal, &str) -> Result<T, DomainError> + 'static,
) -> Case {
    Case {
        name,
        call: Box::new(move |w, p, op| f(w, p, op).map(Into::into)),
    }
}

fn written(r: Result<atm_service::write::Written, DomainError>) -> Result<Value, DomainError> {
    r.map(|w| w.result)
}

impl World {
    /// 每个 U-only 能力都有东西可改：归档 / 垃圾箱项目与一条 PENDING 恢复请求、知识条目、保存视图、设置。
    fn fixtures(&self) -> (Value, Value) {
        self.exec(&format!(
            "INSERT INTO scope_generations (gen, scope_kind, scope_id, reason, epoch, created_at) VALUES
               (3, 'PROJECT', 'PR', 'CREATED', 'ER', '{T0}'), (4, 'PROJECT', 'PT', 'CREATED', 'ET', '{T0}');
             UPDATE app_meta SET scope_gen_counter = 4;
             INSERT INTO projects (id, code, name, lifecycle, health, meta_version, scope_gen, epoch, created_at, updated_at) VALUES
               ('PR', 'ARC', '归档的', 'ARCHIVED', 'UNKNOWN', 0, 3, 'ER', '{T0}', '{T0}'),
               ('PT', 'TRS', '垃圾箱里的', 'TRASHED', 'UNKNOWN', 0, 4, 'ET', '{T0}', '{T0}');
             INSERT INTO counters (project_id, name, next_value) VALUES ('PR', 'work_item', 1), ('PT', 'work_item', 1);
             INSERT INTO project_restore_requests (id, project_id, requested_by, status, request_count, created_at, updated_at)
               VALUES ('RQ', 'PT', 'claude', 'PENDING', 1, '{T0}', '{T0}');"
        ));
        let entry = self
            .svc
            .knowledge_save(
                &user(),
                UserSave {
                    content: Content {
                        slug: "fixture".into(),
                        title: "夹具".into(),
                        summary: "摘要".into(),
                        body_markdown: "正文".into(),
                        ..Content::default()
                    },
                    ..UserSave::default()
                },
                "fixture-k",
            )
            .unwrap()
            .result;
        let view = self
            .svc
            .create_saved_view(
                &user(),
                SavedViewCreate {
                    scope: "GLOBAL".into(),
                    name: "夹具视图".into(),
                    ..SavedViewCreate::default()
                },
                "fixture-v",
            )
            .unwrap()
            .result["view"]
            .clone();
        self.svc
            .set_backup_policy(&user(), BackupPolicy::default(), None, "fixture-b")
            .unwrap();
        (entry, view)
    }
}

fn cases(entry: &Value, view: &Value) -> Vec<Case> {
    let (kid, krev) = (
        entry["id"].as_str().unwrap().to_owned(),
        entry["revisionId"].as_str().unwrap().to_owned(),
    );
    let vid = view["id"].as_str().unwrap().to_owned();
    let kid2 = kid.clone();
    let vid2 = vid.clone();
    vec![
        case("session.force_close", |w, p, op| {
            written(
                w.svc
                    .force_close_session(p, &Target::new("PA", None, op), "SX", true),
            )
        }),
        case("session.git_refresh", |w, p, _| {
            w.svc.refresh_git_context(
                p,
                "PA",
                "S1",
                GitContext {
                    available: true,
                    branch: Some("feature/x".into()),
                    ..GitContext::default()
                },
            )
        }),
        case("project.path_attach", |w, p, op| {
            written(w.svc.attach_path(
                p,
                "ATM",
                PathInfo {
                    canonical_path: "R:\\Elsewhere".into(),
                    git_common_dir: None,
                },
                true,
                op,
            ))
        }),
        case("project.archive", |w, p, op| {
            written(w.svc.set_lifecycle(p, "ATM", Transition::Archive, op))
        }),
        case("project.unarchive", |w, p, op| {
            written(w.svc.set_lifecycle(p, "ARC", Transition::Unarchive, op))
        }),
        case("project.trash", |w, p, op| {
            written(w.svc.set_lifecycle(p, "EMP", Transition::Trash, op))
        }),
        case("project.restore_request.decide", |w, p, op| {
            written(w.svc.decide_restore_request(p, "RQ", false, op))
        }),
        case("project.restore_request.list", |w, p, _| w.svc.trash(p)),
        case("project.untrash", |w, p, op| {
            written(w.svc.set_lifecycle(p, "TRS", Transition::Untrash, op))
        }),
        case("knowledge.user_edit", move |w, p, op| {
            written(w.svc.knowledge_save(
                p,
                UserSave {
                    content: Content {
                        slug: "fixture".into(),
                        title: "改过".into(),
                        summary: "摘要".into(),
                        body_markdown: "新正文".into(),
                        ..Content::default()
                    },
                    id: Some(kid.clone()),
                    expected_version: 1,
                    expected_revision_id: Some(krev.clone()),
                },
                op,
            ))
        }),
        case("knowledge.archive", move |w, p, op| {
            let head = w.svc.knowledge_get(
                &user(),
                &atm_service::read::KnowledgeGetRequest::new(kid2.clone()),
            )?;
            written(w.svc.knowledge_archive(
                p,
                ArchiveRequest {
                    id: kid2.clone(),
                    expected_version: head["version"].as_i64().unwrap(),
                    expected_revision_id: head["revisionId"].as_str().unwrap().to_owned(),
                    archived: true,
                },
                op,
            ))
        }),
        case("saved_view.manage (create)", |w, p, op| {
            written(w.svc.create_saved_view(
                p,
                SavedViewCreate {
                    scope: "GLOBAL".into(),
                    name: "另一个".into(),
                    ..SavedViewCreate::default()
                },
                op,
            ))
        }),
        case("saved_view.manage (update)", move |w, p, op| {
            written(w.svc.update_saved_view(
                p,
                &vid,
                SavedViewUpdate {
                    expected_version: Some(0),
                    name: Some("改名".into()),
                    ..SavedViewUpdate::default()
                },
                op,
            ))
        }),
        case("saved_view.manage (delete)", move |w, p, op| {
            written(w.svc.delete_saved_view(p, &vid2, Some(1), op))
        }),
        case("saved_view.read", |w, p, _| w.svc.list_saved_views(p, None)),
        case("settings.write", |w, p, op| {
            written(w.svc.set_setting(
                p,
                "projects.order",
                json!({ "ids": ["PE", "PA"] }),
                None,
                op,
            ))
        }),
        case("settings.write (backup.policy)", |w, p, op| {
            written(w.svc.set_backup_policy(
                p,
                BackupPolicy {
                    daily_keep: 1,
                    ..BackupPolicy::default()
                },
                None,
                op,
            ))
        }),
        case("notification.mode_set", |w, p, op| {
            written(w.svc.set_notification_mode(p, "OFF", None, op))
        }),
        case("settings.read", |w, p, _| w.svc.list_settings(p)),
    ]
}

/// 03 §5.3：每个 U-only 入口的 Agent 调用都被拒，整库与数据根文件（含备份目录）都不变。
#[test]
fn p005_agents_are_refused_every_user_only_capability_without_side_effects() {
    let w = world("perm-agent");
    let (entry, view) = w.fixtures();
    let list = cases(&entry, &view);
    assert_eq!(list.len(), 19);
    for (i, c) in list.iter().enumerate() {
        let (db, fs) = (w.snapshot(), files(&w.dir));
        let e = (c.call)(&w, &agent(), &format!("agent-{i}"))
            .expect_err(&format!("{} accepted an agent", c.name));
        assert_eq!(
            e.code,
            ErrorCode::USER_AUTHORIZATION_REQUIRED,
            "{}: {e:?}",
            c.name
        );
        assert_eq!(e.details["principal"], "AGENT", "{}", c.name);
        for ((table, a), (_, b)) in db.iter().zip(&w.snapshot()) {
            assert_eq!(a, b, "{}: table {table} changed", c.name);
        }
        assert_eq!(
            fs,
            files(&w.dir),
            "{}: files under the data root changed",
            c.name
        );
    }
}

/// 阳性对照：同一组调用换成 User，每条都成功并留下可见变化（写）或返回内容（读）。
#[test]
fn p005_the_same_calls_succeed_for_the_user() {
    let w = world("perm-user");
    let (entry, view) = w.fixtures();
    let mut changed = 0;
    for (i, c) in cases(&entry, &view).iter().enumerate() {
        let (db, fs) = (w.snapshot(), files(&w.dir));
        let r = (c.call)(&w, &user(), &format!("user-{i}"));
        let v = r.unwrap_or_else(|e| panic!("{} refused the user: {e:?}", c.name));
        assert!(!v.is_null(), "{}", c.name);
        if db != w.snapshot() || fs != files(&w.dir) {
            changed += 1;
        } else {
            assert!(
                c.name.ends_with(".read") || c.name.ends_with(".list"),
                "{} wrote nothing for the user",
                c.name
            );
        }
    }
    assert_eq!(changed, 16);
    // 生命周期迁移确实做了 PRE_* 备份：Agent 用例里文件集合不变不是因为备份从来不写。
    assert!(files(&w.dir).keys().any(|k| k.starts_with("backups/")));
}

/// 03 §5.2：Agent 专属能力对 User 报 PRINCIPAL_CAPABILITY_DENIED，同样零写入。
#[test]
fn p004_users_are_denied_agent_only_capabilities() {
    let w = world("perm-agent-only");
    let before = w.snapshot();
    let e = w
        .svc
        .knowledge_save_agent(
            &user(),
            "ATM",
            "S1",
            atm_service::knowledge::AgentSave {
                content: Content {
                    slug: "x".into(),
                    title: "x".into(),
                    summary: "x".into(),
                    ..Content::default()
                },
                ..atm_service::knowledge::AgentSave::default()
            },
            "u",
        )
        .unwrap_err();
    assert_eq!(
        (e.code, e.details["principal"].clone()),
        (ErrorCode::PRINCIPAL_CAPABILITY_DENIED, json!("USER"))
    );
    let e = w
        .svc
        .add_progress(
            &user(),
            &Target::new("PA", None, "p"),
            atm_service::memory::ProgressRequest::task("ATM-T-0001", "x"),
        )
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::PRINCIPAL_CAPABILITY_DENIED);
    let e = w
        .svc
        .begin(&user(), atm_service::session::BeginRequest::new("USER"))
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::PRINCIPAL_CAPABILITY_DENIED);
    let e = w
        .svc
        .end_session(
            &user(),
            &Target::new("PA", None, "e"),
            atm_service::session::EndRequest {
                outcome: atm_service::session::Outcome::Completed,
                summary: "x".into(),
                next: Vec::new(),
                release_claims: false,
                retirement_reason: None,
                git: None,
            },
        )
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::PRINCIPAL_CAPABILITY_DENIED);
    let e = w
        .svc
        .feedback(
            &user(),
            &Target::new("PA", None, "f"),
            atm_service::memory::FeedbackRequest {
                summary: "x".into(),
                detail: None,
                tool: None,
                severity: None,
                task_key: None,
            },
        )
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::PRINCIPAL_CAPABILITY_DENIED);
    assert_eq!(before, w.snapshot());
}

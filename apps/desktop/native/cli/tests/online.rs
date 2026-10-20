//! 在线命令的黑盒用例（06 §6 T-AG；W6a 验收「每个子命令至少一条对 Rust 服务的成功用例」）：
//! 真实服务 + 真实 Agent HTTP，atm.exe 作为子进程经 `N\runtime\daemon.json` 发现它。

mod support;

use serde_json::{Value, json};
use support::*;

fn sessions(w: &World) -> (i64, i64) {
    w.svc
        .store()
        .read(|tx| {
            tx.query_row(
                "SELECT count(*), count(*) FILTER (WHERE closed_at IS NULL) FROM agent_sessions WHERE agent_id = 'atm-cli'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .unwrap()
}

#[test]
fn status_doctor_and_project_reads() {
    let w = world("cli-reads");
    let status = w.ok(&["status"]);
    assert_eq!(
        (status["impl"].clone(), status["layout"].clone()),
        (json!("rust"), json!("single"))
    );
    assert_eq!(status["version"], "3.0.0-test");

    // doctor：服务状态加上本机离线检查；离线部分不带令牌。
    let doctor = w.atm(&["--json", "doctor"]);
    assert_eq!(doctor.code, 0, "{}{}", doctor.stdout, doctor.stderr);
    let d = doctor.json();
    assert_eq!(d["service"]["impl"], "rust", "{d}");
    assert_eq!(d["local"]["database"]["projects"], 1, "{d}");
    assert_eq!(d["local"]["service"]["pid_alive"], true, "{d}");
    assert!(!doctor.stdout.contains(TOKEN));

    let list = w.ok(&["project", "list"]);
    assert_eq!(list["projects"][0]["code"], w.project);
    let human = w.atm(&["project", "list"]);
    assert_eq!(human.stdout, format!("{}  演示\n", w.project));

    let open = w.ok(&["project", "open", &w.project]);
    assert_eq!(open["code"], w.project);

    let brief = w.ok(&["brief", &w.project]);
    assert_eq!(brief["project"], w.project);
    assert_eq!(brief["next"][0], w.task, "{brief}");
}

#[test]
fn project_create_writes_the_marker() {
    let w = world("cli-project-create");
    let repo = w.root.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    // 相对路径按当前目录（数据根）解析。
    let created = w.ok(&[
        "project",
        "create",
        "repo",
        "--name",
        "新项目",
        "--code",
        "NEW",
        "--mode",
        "solo",
    ]);
    assert_eq!(created["operation"], "project.create", "{created}");
    assert_eq!(created["result"]["project"]["code"], "NEW", "{created}");
    assert_eq!(created["marker_written"], true, "{created}");
    assert!(repo.join(".ayanami-task").join("project.json").is_file());
    let list = w.ok(&["project", "list"]);
    let codes: Vec<&Value> = list["projects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| &p["code"])
        .collect();
    assert!(codes.contains(&&json!("NEW")), "{list}");
    // --mode 只认三种，本地就拦下。
    let bad = w.atm(&[
        "project", "create", "repo", "--name", "x", "--mode", "solo-ish",
    ]);
    assert_eq!(bad.code, 2, "{}", bad.stderr);
    assert!(bad.stderr.contains("--mode 只能是"), "{}", bad.stderr);
}

#[test]
fn quick_tasks_are_added_listed_and_promoted() {
    let w = world("cli-quick");
    let added = w.ok(&["quick", "add", "顺手记一下", "--note", "备注"]);
    assert_eq!(added["operation"], "quick.create", "{added}");
    let quick = &added["result"]["quick"];
    assert_eq!(quick["note"], "备注");
    let id = quick["id"].as_str().unwrap().to_owned();
    let version = quick["version"].as_i64().unwrap().to_string();

    let open = w.ok(&["quick", "list", "--status", "open"]);
    assert_eq!(open["quick_tasks"].as_array().unwrap().len(), 1, "{open}");
    let human = w.atm(&["quick", "list"]);
    assert!(
        human.stdout.contains("[OPEN]  顺手记一下"),
        "{}",
        human.stdout
    );

    let promoted = w.ok(&[
        "quick",
        "promote",
        &id,
        "--project",
        &w.project,
        "--version",
        &version,
    ]);
    assert_eq!(promoted["operation"], "quick.promote", "{promoted}");
    let after = w.ok(&["quick", "list", "--status", "promoted"]);
    assert_eq!(after["quick_tasks"][0]["id"], id.as_str(), "{after}");
}

#[test]
fn tasks_are_listed_shown_created_and_patched_in_their_own_sessions() {
    let w = world("cli-tasks");
    let list = w.ok(&["task", "list", &w.project]);
    assert_eq!(list["items"][0]["key"], w.task, "{list}");
    let human = w.atm(&["task", "list", &w.project]);
    assert_eq!(human.stdout, format!("{}  [READY]  第一个任务\n", w.task));

    let shown = w.ok(&["task", "show", &w.task.to_lowercase()]);
    assert_eq!(shown["key"], w.task, "{shown}");
    assert_eq!(shown["title"], "第一个任务", "{shown}");

    // task create：计划文件（带 BOM 也行），在一个新 session 里建，建完 session 就结束。
    let plan = w.root.join("plan.json");
    std::fs::write(
        &plan,
        format!(
            "\u{feff}{}",
            json!({"items": [{"title": "CLI 计划一", "acceptance": ["写完"]}, {"title": "CLI 计划二"}]})
        ),
    )
    .unwrap();
    let created = w.ok(&["task", "create", &w.project, "--file", "plan.json"]);
    assert_eq!(created["ok"], true, "{created}");
    let created_keys: Vec<String> = created["entities"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["entity_type"] == "WORK_ITEM")
        .map(|e| e["key"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(created_keys.len(), 2, "{created}");
    assert_eq!(sessions(&w), (1, 0));

    // task patch：版本取现读的；start 之后 session 结束、领取放掉。
    let version = w.ok(&["task", "show", &w.task])["version"]
        .as_i64()
        .unwrap()
        .to_string();
    let patched = w.ok(&[
        "task",
        "patch",
        &w.task,
        "--version",
        &version,
        "--operation",
        "start",
    ]);
    assert_eq!(patched["ok"], true, "{patched}");
    let now = w.ok(&["task", "show", &w.task, "--view", "core"]);
    assert_eq!(now["status"], "IN_PROGRESS", "{now}");
    assert_eq!(sessions(&w), (2, 0));

    // 服务回错误：退出码 1，--json 时 stdout 是 {"error": 信封}；session 照样结束。
    let stale = w.atm(&[
        "--json",
        "task",
        "patch",
        &w.task,
        "--version",
        "0",
        "--operation",
        "block",
        "--reason",
        "等",
    ]);
    assert_eq!(stale.code, 1, "{}{}", stale.stdout, stale.stderr);
    let e = stale.json();
    assert!(e["error"]["code"].is_string(), "{e}");
    assert_eq!(e["error"]["committed"], false, "{e}");
    assert_eq!(sessions(&w), (3, 0));
    let human = w.atm(&[
        "task",
        "patch",
        &w.task,
        "--version",
        "0",
        "--operation",
        "block",
        "--reason",
        "等",
    ]);
    assert_eq!(human.code, 1);
    assert!(
        human
            .stderr
            .starts_with(e["error"]["code"].as_str().unwrap()),
        "{}",
        human.stderr
    );
}

/// `task list` 跟随游标翻页：单页最多 100 条，要 105 条时取两页拼起来。
#[test]
fn task_list_follows_the_cursor() {
    let w = world("cli-task-pages");
    let agent = w.agent();
    // 一次最多建 50 条：分三批凑出 104 条（加上夹具里的一条共 105）。
    for (batch, range) in [(0, 0..50), (1, 50..100), (2, 100..104)] {
        let items: Vec<atm_service::work::CreateItem> = range
            .map(|i| atm_service::work::CreateItem {
                title: format!("批量 {i}"),
                ..Default::default()
            })
            .collect();
        w.svc
            .create_work_items(
                &agent,
                &atm_service::work::Target::new(
                    &w.project_id,
                    Some(&w.session),
                    format!("bulk-{batch}"),
                ),
                items,
            )
            .unwrap();
    }
    let all = w.ok(&[
        "task", "list", &w.project, "--limit", "105", "--view", "core",
    ]);
    let keys = all["items"].as_array().unwrap();
    assert_eq!(keys.len(), 105, "{}", all["returned_count"]);
    assert_eq!(all["returned_count"], 105);
    let unique: std::collections::BTreeSet<&str> =
        keys.iter().map(|k| k["key"].as_str().unwrap()).collect();
    assert_eq!(unique.len(), 105);
    let three = w.ok(&["task", "list", &w.project, "--limit", "3"]);
    assert_eq!(three["items"].as_array().unwrap().len(), 3);
    assert_eq!(three["has_more"], true);
    let human = w.atm(&["task", "list", &w.project, "--limit", "3"]);
    assert!(
        human
            .stdout
            .ends_with("……还有更多，用 --json 查看完整结果\n"),
        "{}",
        human.stdout
    );
}

#[test]
fn progress_and_records_are_written_in_their_own_sessions() {
    let w = world("cli-memory");
    let progress = w.ok(&[
        "progress",
        &w.task,
        "--summary",
        "写到一半",
        "--percent",
        "40",
    ]);
    assert_eq!(progress["ok"], true, "{progress}");
    let shown = w.ok(&["task", "show", &w.task, "--view", "core"]);
    assert_eq!(shown["progress"], 40, "{shown}");
    let record = w.ok(&[
        "record",
        &w.project,
        "--kind",
        "decision",
        "--summary",
        "用 Rust 重写",
        "--detail",
        "细节",
    ]);
    let key = record["entities"][0]["key"].as_str().unwrap().to_owned();
    assert!(key.starts_with(&format!("{}-D-", w.project)), "{record}");
    assert_eq!(sessions(&w), (2, 0));

    let events = w.ok(&["events", &w.project, "--since", "0"]);
    let kinds: Vec<&str> = events["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["type"].as_str().unwrap())
        .collect();
    assert!(
        kinds.contains(&"record.created") || kinds.iter().any(|k| k.starts_with("record")),
        "{kinds:?}"
    );
    let tail = w.ok(&[
        "events",
        &w.project,
        "--since",
        &events["current_sequence"].to_string(),
    ]);
    assert_eq!(tail["events"], json!([]), "{tail}");

    let global = w.ok(&["search", "用 Rust 重写"]);
    assert_eq!(global["hits"][0]["entity_key"], key.as_str(), "{global}");
    let scoped = w.ok(&["search", "第一个任务", "--project", &w.project]);
    assert_eq!(scoped["hits"][0]["entity_key"], w.task, "{scoped}");
    let human = w.atm(&["search", "第一个任务"]);
    assert!(
        human
            .stdout
            .lines()
            .any(|l| l == format!("{}  [WORK_ITEM]  第一个任务", w.task)),
        "{}",
        human.stdout
    );
}

#[test]
fn backups_list_both_kinds_and_import_previews() {
    let w = world("cli-backups");
    w.svc
        .store()
        .write(|tx| {
            tx.execute_batch(
                "INSERT INTO legacy_backups (id, source, scope, project_id, legacy_path, importable, created_at)
                 VALUES ('cat-1', 'CATALOG', 'KNOWLEDGE', NULL, 'L:/backups/cat-1', 'AS_KNOWLEDGE', '2026-09-01T00:00:00.000Z')",
            )
        })
        .unwrap();
    let list = w.ok(&["backup", "list", "--project", &w.project]);
    assert_eq!(list["backups"], json!([]), "{list}");
    assert_eq!(list["legacyBackups"][0]["id"], "cat-1", "{list}");
    let human = w.atm(&["backup", "list"]);
    assert_eq!(
        human.stdout,
        "3.0 整库备份：\n没有记录。\n2.x 备份（只能在应用内作为项目或知识库导入）：\ncat-1  KNOWLEDGE  2026-09-01T00:00:00.000Z\n"
    );

    std::fs::write(w.root.join("agenttask.md"), "# 计划\n\n- [ ] 第一步\n").unwrap();
    let preview = w.ok(&[
        "import",
        "agenttask.md",
        "--project",
        &w.project,
        "--preview",
    ]);
    assert!(preview["sha256"].is_string(), "{preview}");
}

/// ATM_ENDPOINT + ATM_TOKEN 覆盖 daemon.json；只给一个、或不是回环 http，不发请求就报错。
#[test]
fn the_environment_override_wins_and_is_checked() {
    let w = world("cli-override");
    // daemon.json 指向一个没人听的端口：只有走覆盖才连得上。
    write_descriptor(&w.root, 1, TOKEN);
    let endpoint = format!("http://127.0.0.1:{}", w.port);
    let run = atm_with(
        &w.root,
        &["--json", "status"],
        &[("ATM_ENDPOINT", &endpoint), ("ATM_TOKEN", TOKEN)],
    );
    assert_eq!(run.code, 0, "{}{}", run.stdout, run.stderr);
    for (env, code) in [
        (
            vec![("ATM_ENDPOINT", endpoint.as_str())],
            "ATM_RUNTIME_OVERRIDE_INCOMPLETE",
        ),
        (
            vec![("ATM_TOKEN", TOKEN)],
            "ATM_RUNTIME_OVERRIDE_INCOMPLETE",
        ),
        (
            vec![("ATM_ENDPOINT", "http://localhost:1"), ("ATM_TOKEN", TOKEN)],
            "ATM_RUNTIME_ENDPOINT_INVALID",
        ),
        (
            vec![
                ("ATM_ENDPOINT", "https://127.0.0.1:1"),
                ("ATM_TOKEN", TOKEN),
            ],
            "ATM_RUNTIME_ENDPOINT_INVALID",
        ),
    ] {
        let run = atm_with(&w.root, &["--json", "project", "list"], &env);
        assert_eq!(run.code, 4, "{env:?}: {}{}", run.stdout, run.stderr);
        assert_eq!(run.json()["error"]["code"], code, "{env:?}");
    }
    // 令牌不对：服务回 401，退出码 1，令牌不出现在输出里。
    let run = atm_with(
        &w.root,
        &["--json", "project", "list"],
        &[
            ("ATM_ENDPOINT", &endpoint),
            ("ATM_TOKEN", "wrong-token-0123456789"),
        ],
    );
    assert_eq!(run.code, 1, "{}{}", run.stdout, run.stderr);
    assert!(!run.stdout.contains("wrong-token") && !run.stderr.contains("wrong-token"));
}

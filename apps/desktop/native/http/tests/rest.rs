//! Agent REST（06 §2；03 §5；W4h）：路由表、拒绝桩、删除守卫、提示路由，经真实监听器验。
//!
//! - T-AG：表与 06 §2 一致（加 00 C-07 对 #27 的改动）；每条 A / A+U 都接到了服务上；工具背后的路由与
//!   MCP 工具是同一套参数与回执。
//! - T-GONE：每条「U」与「删」在 Agent HTTP 上是 404（同一路径有别的方法时也是 404）；MCP 的 GET / DELETE 是 405。
//! - T-DENY：每条 U\* 都是 403 `USER_AUTHORIZATION_REQUIRED`，details 带 `{principal, where, next_step}`；整轮
//!   拒绝前后，整库（NS-1、NS-2）、数据根文件与备份（NS-3、NS-4）、项目目录（NS-7）逐字节不变。阳性对照：
//!   同样的能力换成 User 调服务，指纹都会变。子进程、网络、宿主与内存状态（NS-5、NS-6、NS-8、NS-9）在拒绝
//!   桩上没有通道——桩不读 body、不调服务；「桩绑上处理器」的变异验红。
//! - T-HINT：delta 的 `oversized_event` 与 `CANDIDATE_HASH_MISMATCH` 的 `request_lookup` 给出的路径，原样以
//!   bearer GET，得 200 且内容就是提示所指。

mod support;

use atm_domain::evidence::{Evidence, EvidenceKind};
use atm_domain::principal::{Principal, UiSurface};
use atm_http::rest::{Disp, ROUTES};
use atm_service::project::Transition;
use atm_service::session::BeginRequest;
use atm_service::work::{CreateItem, NewChecklist, ReviewRequest, ReviewSubmit, Target, Verdict};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::Path;
use support::*;

fn user() -> Principal {
    Principal::trusted_ui(UiSurface::Tray)
}

fn agent() -> Principal {
    Principal::authenticated_agent(None)
}

fn numbers(f: impl Fn(&Disp) -> bool) -> Vec<u16> {
    ROUTES.iter().filter(|r| f(&r.disp)).map(|r| r.n).collect()
}

/// 路由的一个具体路径：参数换成样例值。
fn concrete(w: &World, path: &str) -> String {
    path.split('/')
        .map(|s| match s.strip_prefix(':') {
            Some("code" | "projectCode") => w.project.clone(),
            Some("taskKey") => w.task.clone(),
            Some("requestKey") => format!("{}-RR-0001", w.project),
            Some("id") => "ZZ-404".into(),
            Some(other) => format!("sample-{other}"),
            None => s.to_owned(),
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn parse(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|e| panic!("{e}: {text}"))
}

/// T-AG：表就是 06 §2（109 条，编号 1..=109），处置与 06 一致，只有 #27 按 00 C-07 改成拒绝桩，
/// #3、#4 随投影健康面板删除（00 §6，W5）。
/// 清单写死在这里：任何一条换处置都要改这个用例（守卫，不跟着表走）。
#[test]
fn the_route_table_is_06_section_2_with_c07() {
    let ns: Vec<u16> = ROUTES.iter().map(|r| r.n).collect();
    assert_eq!(ns, (1..=109).collect::<Vec<u16>>());
    assert_eq!(
        numbers(|d| *d == Disp::A),
        [16, 51, 52, 64, 65, 66, 70, 74, 75, 80, 81]
    );
    assert_eq!(
        numbers(|d| *d == Disp::Au),
        [1, 11, 15, 22, 25, 41, 68, 77, 78, 79, 84, 85, 87]
    );
    assert_eq!(
        numbers(|d| matches!(d, Disp::UStar(_))),
        [
            6, 8, 10, 13, 14, 19, 20, 21, 23, 24, 26, 27, 39, 40, 45, 47, 50, 53, 54, 55, 56, 59,
            76, 82, 83, 89, 90, 91, 93, 94, 95, 96
        ]
    );
    assert_eq!(
        numbers(|d| *d == Disp::U),
        [
            2, 5, 9, 12, 18, 28, 29, 30, 32, 33, 36, 42, 44, 48, 49, 60, 61, 62, 63, 86, 88, 92
        ]
    );
    assert_eq!(
        numbers(|d| *d == Disp::Gone),
        [
            3, 4, 7, 17, 31, 34, 35, 37, 38, 43, 46, 57, 58, 67, 69, 71, 72, 73, 97, 101, 102, 109
        ]
    );
    assert_eq!(
        numbers(|d| *d == Disp::Mcp),
        [98, 99, 100, 103, 104, 105, 106, 107, 108]
    );
    // 提示路由必须保留（06 #70、#79）。
    for n in [70, 79] {
        assert!(matches!(ROUTES[n - 1].disp, Disp::A | Disp::Au), "#{n}");
    }
    // 没有两条同方法同路径。
    let mut seen = std::collections::BTreeSet::new();
    for r in ROUTES {
        assert!(seen.insert((r.method, r.path)), "#{} duplicated", r.n);
    }
}

/// T-AG：每条 A / A+U 都接到了服务上——不是 404 / 405，也不是「没有接到服务上」的内部错误。
#[test]
fn every_agent_route_reaches_the_service() {
    let w = world("rest-reach");
    for r in ROUTES
        .iter()
        .filter(|r| matches!(r.disp, Disp::A | Disp::Au))
    {
        let path = concrete(&w, r.path);
        let body = if r.method == "GET" { "" } else { "{}" };
        let (status, text) = http(w.port, r.method, &path, body);
        let v = parse(&text);
        assert!(
            !matches!(status, 404 | 405 | 500)
                || v["code"]
                    .as_str()
                    .is_some_and(|c| c.ends_with("_NOT_FOUND") && c != "NOT_FOUND"),
            "#{} {} {path}: {status} {text}",
            r.n,
            r.method
        );
        assert_ne!(v["code"], "INTERNAL_ERROR", "#{}: {text}", r.n);
        assert_ne!(v["code"], "METHOD_NOT_ALLOWED", "#{}: {text}", r.n);
        assert_ne!(v["code"], "NOT_FOUND", "#{}: {text}", r.n);
    }
}

/// T-GONE：「U」与「删」在 Agent HTTP 上一律 404；MCP 入口的 GET / DELETE 是 405。
#[test]
fn ui_only_and_deleted_routes_are_404() {
    let w = world("rest-gone");
    for r in ROUTES
        .iter()
        .filter(|r| matches!(r.disp, Disp::U | Disp::Gone))
    {
        let path = concrete(&w, r.path);
        let body = if r.method == "GET" { "" } else { "{}" };
        let (status, text) = http(w.port, r.method, &path, body);
        assert_eq!(status, 404, "#{} {} {path}: {text}", r.n, r.method);
        assert_eq!(parse(&text)["code"], "NOT_FOUND", "#{}", r.n);
    }
    for r in ROUTES
        .iter()
        .filter(|r| r.disp == Disp::Mcp && r.method != "POST")
    {
        let (status, text) = http(w.port, r.method, r.path, "");
        assert_eq!(status, 405, "#{} {}: {text}", r.n, r.method);
    }
    // 不在表里的方法仍是 405（路径存在）；不在表里的路径是 404。
    let (status, _) = http(w.port, "DELETE", "/api/v1/projects", "");
    assert_eq!(status, 405);
    let (status, _) = http(w.port, "GET", "/api/v1/nothing-here", "");
    assert_eq!(status, 404);
}

// ---- T-DENY -------------------------------------------------------------------------------------

/// 整库逐表逐行（NS-1；各种序号与世代都在表里，NS-2 随之）。
fn database(w: &World) -> BTreeMap<String, Vec<String>> {
    w.svc
        .store()
        .read(|tx| -> rusqlite::Result<BTreeMap<String, Vec<String>>> {
            let tables: Vec<String> = tx
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")?
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            let mut out = BTreeMap::new();
            for t in tables {
                let mut stmt = tx.prepare(&format!("SELECT * FROM \"{t}\""))?;
                let columns = stmt.column_count();
                let mut rows: Vec<String> = stmt
                    .query_map([], |r| {
                        let mut row = Vec::new();
                        for i in 0..columns {
                            row.push(format!("{:?}", r.get_ref(i)?));
                        }
                        Ok(row.join("|"))
                    })?
                    .collect::<rusqlite::Result<_>>()?;
                rows.sort();
                out.insert(t, rows);
            }
            Ok(out)
        })
        .unwrap()
}

/// 目录下的文件：相对路径 → 内容（NS-3、NS-4、NS-7）。库文件不算（NS-1 管）。
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
                if !rel.contains("atm.sqlite") {
                    out.insert(rel, std::fs::read(&p).unwrap_or_default());
                }
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

type Print = (
    BTreeMap<String, Vec<String>>,
    BTreeMap<String, Vec<u8>>,
    BTreeMap<String, Vec<u8>>,
);

/// C-L03：REST 建项目在提交之后写 marker；写不成（`.ayanami-task` 是个文件）项目照样建成，
/// 回执报告 `marker_written: false`。
#[test]
fn c_l03_rest_project_create_reports_the_marker_honestly() {
    let w = world("rest-marker");
    let blocked = w.dir.join("blocked");
    std::fs::create_dir_all(&blocked).unwrap();
    std::fs::write(blocked.join(".ayanami-task"), "not a directory").unwrap();
    let (status, text) = http(
        w.port,
        "POST",
        "/api/v1/projects",
        &json!({"name": "Blocked", "code": "BLOK", "path": blocked.to_string_lossy(), "op_id": "blok-proj"})
            .to_string(),
    );
    assert_eq!(status, 201, "{text}");
    assert_eq!(parse(&text)["marker_written"], false, "{text}");
    assert_eq!(
        std::fs::read_to_string(blocked.join(".ayanami-task")).unwrap(),
        "not a directory"
    );
    let count: i64 = w
        .svc
        .store()
        .read(|tx| {
            tx.query_row(
                "SELECT count(*) FROM projects WHERE code = 'BLOK'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(count, 1);
}

fn print(w: &World, project_dir: &Path) -> Print {
    (database(w), files(&w.dir), files(project_dir))
}

/// T-DENY：Agent 令牌调每条 U\* → 403，带 03 §5.2 的 details；整轮前后零副作用。body 给的是那条路由
/// 在 2.0 能执行的样子，桩也不看。
#[test]
fn every_user_only_route_is_refused_without_side_effects() {
    let w = world("rest-deny");
    // 一个有目录的项目（NS-7：marker、git exclude 都不能被动）。
    let project_dir = w.dir.join("repo");
    std::fs::create_dir_all(&project_dir).unwrap();
    let (status, text) = http(
        w.port,
        "POST",
        "/api/v1/projects",
        &json!({"name": "Deny Target", "code": "DENY", "path": project_dir.to_string_lossy(), "op_id": "deny-proj"})
            .to_string(),
    );
    assert_eq!(status, 201, "{text}");
    assert_eq!(parse(&text)["marker_written"], true, "{text}");
    w.svc.create_manual_backup(&user()).unwrap();
    let before = print(&w, &project_dir);
    let body = json!({
        "name": "x", "title": "x", "summary": "x", "value": 1, "content": "# x", "project": w.project,
        "op_id": "deny-op", "expected_version": 1, "approve": true, "items": [{"title": "x"}],
        "path": project_dir.to_string_lossy(),
    })
    .to_string();
    let mut denied = 0;
    for r in ROUTES {
        let Disp::UStar(deny) = r.disp else { continue };
        let path = concrete(&w, r.path);
        let path = path.replace(&w.project, "DENY");
        let (status, text) = http(
            w.port,
            r.method,
            &path,
            if r.method == "GET" { "" } else { &body },
        );
        assert_eq!(status, 403, "#{} {} {path}: {text}", r.n, r.method);
        let v = parse(&text);
        assert_eq!(v["code"], "USER_AUTHORIZATION_REQUIRED", "#{}", r.n);
        assert_eq!(
            (v["retryable"].clone(), v["committed"].clone()),
            (json!(false), json!(false))
        );
        let d = &v["details"];
        assert_eq!(d["principal"], "AGENT", "#{}", r.n);
        assert_eq!(d["where"], deny.entry(), "#{}", r.n);
        assert!(d["where"].as_str().unwrap().starts_with("ATM"), "#{}", r.n);
        assert_eq!(d["next_step"], atm_domain::capability::USER_NEXT_STEP);
        assert_eq!(d["route"], r.n);
        assert_eq!(v["fix"]["kind"], "ask_user", "#{}: {text}", r.n);
        denied += 1;
    }
    assert_eq!(denied, 32);
    let after = print(&w, &project_dir);
    assert!(before.0 == after.0, "NS-1/NS-2: the database changed");
    assert!(
        before.1 == after.1,
        "NS-3/NS-4: files under the data root changed"
    );
    assert!(before.2 == after.2, "NS-7: the project directory changed");

    // 阳性对照：同样的能力换成 User，指纹一定会变（不是空转）。
    let mut last = after;
    let mut changed = |w: &World, what: &str, f: &dyn Fn()| {
        f();
        let now = print(w, &project_dir);
        assert!(
            now != last,
            "positive control did not change anything: {what}"
        );
        last = now;
    };
    changed(&w, "backup.create_manual (#23)", &|| {
        w.svc.create_manual_backup(&user()).unwrap();
    });
    changed(&w, "settings.write (#10)", &|| {
        w.svc
            .set_setting(
                &user(),
                "recovery.sessionTimeoutMinutes",
                json!(90),
                None,
                "deny-setting",
            )
            .unwrap();
    });
    changed(&w, "project.archive (#19)", &|| {
        w.svc
            .set_lifecycle(&user(), "DENY", Transition::Archive, "deny-archive")
            .unwrap();
    });
}

/// T-DENY（06 #85）：Agent 自报 USER 当 quick 的 actor 也是 USER_AUTHORIZATION_REQUIRED，带 where 与 next_step。
#[test]
fn an_agent_cannot_speak_as_the_user_on_quick_tasks() {
    let w = world("rest-quick-actor");
    let (status, text) = http(
        w.port,
        "POST",
        "/api/v1/quick-tasks",
        &json!({"title": "冒充", "actor": "user"}).to_string(),
    );
    assert_eq!(status, 403, "{text}");
    let v = parse(&text);
    assert_eq!(v["code"], "USER_AUTHORIZATION_REQUIRED");
    assert_eq!(v["details"]["principal"], "AGENT");
    assert!(
        v["details"]["where"].is_string() && v["details"]["next_step"].is_string(),
        "{text}"
    );
    let n = w
        .svc
        .store()
        .read(|tx| {
            tx.query_row("SELECT count(*) FROM quick_tasks", [], |r| {
                r.get::<_, i64>(0)
            })
        })
        .unwrap();
    assert_eq!(n, 0);
}

// ---- 工具背后的路由 --------------------------------------------------------------------------------

/// 工具背后的 REST 与 MCP 工具同一套参数：路径注入 project / task_key / session，query 按字段类型转换，
/// 写入回同一个 ACK；路径与 body 冲突是参数错误，不悄悄挑一个。
#[test]
fn tool_routes_speak_the_tool_contract() {
    let w = world("rest-tools");
    let base = format!("/api/v1/projects/{}", w.project);

    let (status, text) = http(
        w.port,
        "GET",
        &format!("{base}/work-items?limit=1&status=open&view=core"),
        "",
    );
    assert_eq!(status, 200, "{text}");
    let list = parse(&text);
    assert_eq!(list["items"][0]["key"], w.task, "{text}");

    let (status, text) = http(w.port, "GET", &format!("{base}/work-items/{}", w.task), "");
    assert_eq!(status, 200, "{text}");
    assert_eq!(parse(&text)["key"], w.task, "{text}");

    let (status, text) = http(
        w.port,
        "POST",
        &format!("{base}/progress-updates"),
        &json!({"session": w.session, "task_key": w.task, "summary": "写到一半", "op_id": "rest-prog"}).to_string(),
    );
    assert_eq!(status, 200, "{text}");
    let ack = parse(&text);
    assert_eq!(
        (ack["ok"].clone(), ack["op_id"].clone()),
        (json!(true), json!("rest-prog")),
        "{text}"
    );
    // 同一调用再来一次：同一个 op_id 重放。
    let (_, again) = http(
        w.port,
        "POST",
        &format!("{base}/progress-updates"),
        &json!({"session": w.session, "task_key": w.task, "summary": "写到一半", "op_id": "rest-prog"}).to_string(),
    );
    assert_eq!(parse(&again)["replayed"], true, "{again}");

    let (status, text) = http(
        w.port,
        "POST",
        &format!("{base}/records"),
        &json!({"session": w.session, "kind": "FACT", "title": "经 REST", "summary": "记一笔"})
            .to_string(),
    );
    assert_eq!(status, 201, "{text}");

    let (status, text) = http(
        w.port,
        "GET",
        &format!("{base}/search?query=%E7%BB%8F%20REST"),
        "",
    );
    assert_eq!(status, 200, "{text}");
    assert!(text.contains("经 REST"), "{text}");

    let (status, text) = http(w.port, "GET", &format!("{base}/brief"), "");
    assert_eq!(status, 200, "{text}");

    // 2.0 REST 的 camelCase 写法照收（顶层与 items 里的对象）。版本取现读的。
    let (_, now) = http(w.port, "GET", &format!("{base}/work-items/{}", w.task), "");
    let version = parse(&now)["version"].as_i64().unwrap();
    let (status, text) = http(
        w.port,
        "POST",
        &format!("{base}/work-items/patch"),
        &json!({"session": w.session, "taskKey": w.task, "operation": "start", "expectedVersion": version}).to_string(),
    );
    assert_eq!(status, 200, "{text}");

    // 路径与 body 不一致：参数冲突，什么都没写。
    let (status, text) = http(
        w.port,
        "POST",
        &format!("{base}/records"),
        &json!({"project": "OTHER", "session": w.session, "kind": "FACT", "title": "冲突", "summary": "s"}).to_string(),
    );
    assert_eq!(status, 400, "{text}");
    let v = parse(&text);
    assert_eq!(v["code"], "INVALID_ARGUMENT");
    assert_eq!(v["problems"][0]["path"], "project", "{text}");
    assert_eq!(
        v["fix"]["call"]["arguments"]["project"], w.project,
        "{text}"
    );
    atm_http::fix::check(&v).unwrap();

    // begin 与 end：路径里的 session 注入。
    let (status, text) = http(
        w.port,
        "POST",
        "/api/v1/sessions",
        &json!({"agent_id": "codex", "project": w.project, "op_id": "rest-begin"}).to_string(),
    );
    assert_eq!(status, 201, "{text}");
    let session = parse(&text)["session"].as_str().unwrap().to_owned();
    let (status, text) = http(
        w.port,
        "POST",
        &format!("/api/v1/sessions/{session}/close"),
        &json!({"summary": "收工"}).to_string(),
    );
    assert_eq!(status, 200, "{text}");

    // 2.0 REST 的 begin 体照收：`operationId`（原子 begin）与其余 camelCase 字段；同一个 operationId 再来一次
    // 拿回同一个 session，不再建一个。
    let body = json!({"operationId": "rest-atomic", "projectCode": w.project, "mode": "project",
                      "agentId": "release-cli", "displayName": "发布流水线", "clientKind": "cli", "role": "SUBAGENT"})
    .to_string();
    let (status, text) = http(w.port, "POST", "/api/v1/sessions", &body);
    assert_eq!(status, 201, "{text}");
    let first = parse(&text)["session"].clone();
    assert!(first.is_string(), "{text}");
    let (status, again) = http(w.port, "POST", "/api/v1/sessions", &body);
    assert!(status == 200 || status == 201, "{again}");
    assert_eq!(parse(&again)["session"], first, "{again}");

    // 2.0 的 `1` / `0` 布尔照收。
    let (status, text) = http(
        w.port,
        "GET",
        &format!("{base}/work-items?mine=1&session={}", w.session),
        "",
    );
    assert_eq!(status, 200, "{text}");

    // GET 的 query 类型不对：与工具同一个校验器报出来。
    let (status, text) = http(w.port, "GET", &format!("{base}/work-items?limit=many"), "");
    assert_eq!(status, 400, "{text}");
}

/// 一次 REST 调用；出错时信封必须兑现 U-4（有下一步、不退回兜底、fix 里的调用过对应的参数表）。
fn rest(w: &World, method: &str, path: &str, body: &str) -> (u16, Value) {
    let (status, text) = http(w.port, method, path, body);
    let v = parse(&text);
    if status >= 400 {
        atm_http::fix::check(&v).unwrap_or_else(|e| panic!("{method} {path}: {e}: {text}"));
    }
    (status, v)
}

fn paths(v: &Value) -> Vec<String> {
    v["problems"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["path"].as_str().unwrap().to_owned())
        .collect()
}

/// REST 的错误路径同样兑现 U-4（peer W4 r1 P1-04）：路径冲突与越界、未知字段、组合约束一起报，fix.call 是
/// 都更正过并且能直接执行的同一调用；自有路由缺 session 时出路指回这条路由，不退回 none。
#[test]
fn rest_errors_hand_out_fixes_that_pass_their_schema() {
    let w = world("rest-u4");
    let base = format!("/api/v1/projects/{}", w.project);

    // 冲突 + 越界：fix.call 两处都改过，照着调就成。
    let (status, v) = rest(
        &w,
        "GET",
        &format!("{base}/work-items?project=WRONG&limit=999"),
        "",
    );
    assert_eq!(
        (status, &v["code"]),
        (400, &json!("INVALID_ARGUMENT")),
        "{v}"
    );
    assert_eq!(paths(&v), ["limit", "project"], "{v}");
    let call_args = v["fix"]["call"]["arguments"].clone();
    assert_eq!(call_args["project"], json!(w.project), "{v}");
    assert_ne!(call_args["limit"], json!(999), "{v}");
    let followed = call(
        &w,
        "core",
        v["fix"]["call"]["name"].as_str().unwrap(),
        call_args,
    );
    assert_ne!(followed["isError"], json!(true), "{followed}");

    // 别名写的冲突 + 拼错的字段：冲突的那一项去掉，拼错的按 did_you_mean 改名。
    let (_, v) = rest(
        &w,
        "GET",
        &format!("{base}/work-items?Project_Code=WRONG&limt=5"),
        "",
    );
    assert_eq!(paths(&v), ["Project_Code", "limt"], "{v}");
    let call_args = &v["fix"]["call"]["arguments"];
    assert_eq!(
        (&call_args["project"], &call_args["limit"]),
        (&json!(w.project), &json!(5)),
        "{v}"
    );
    assert!(call_args.get("Project_Code").is_none(), "{v}");

    // 冲突 + 组合约束（搜索既没有 query 也没有 op_id）：更正不了，给 add_param。
    let (_, v) = rest(&w, "GET", &format!("{base}/search?project=WRONG"), "");
    assert!(paths(&v).contains(&"project".to_owned()), "{v}");
    assert_eq!(v["fix"]["kind"], json!("add_param"), "{v}");

    // 自有路由：冲突 + 越界，fix.call 指回这条路由的参数表。
    let (_, v) = rest(
        &w,
        "GET",
        &format!("{base}/events?project=WRONG&limit=999"),
        "",
    );
    assert_eq!(paths(&v), ["limit", "project"], "{v}");
    assert_eq!(
        v["fix"]["call"]["name"],
        json!("GET /api/v1/projects/:code/events"),
        "{v}"
    );

    // 自有路由缺 session：SESSION_REQUIRED，出路是给这条路由补 session，不是 none。
    let (status, v) = rest(
        &w,
        "POST",
        &format!("{base}/objectives"),
        &json!({"title": "no-session"}).to_string(),
    );
    assert_eq!(
        (status, &v["code"]),
        (422, &json!("SESSION_REQUIRED")),
        "{v}"
    );
    assert_eq!(
        (&v["fix"]["kind"], &v["fix"]["param"], &v["fix"]["tool"]),
        (
            &json!("add_param"),
            &json!("session"),
            &json!("POST /api/v1/projects/:code/objectives")
        ),
        "{v}"
    );
}

/// REST 自有路由在提交之后读 ACK 失败：同 MCP 写工具一样报 committed:true、按 op_id 回查（W4 r2 P1-01）。
#[test]
fn an_own_route_reports_a_commit_whose_ack_could_not_be_read() {
    let w = world("rest-after-commit");
    w.svc
        .set_after_commit_read_fault(Some(std::sync::Arc::new(|site: &str| {
            (site == "mutation.ack").then(|| {
                atm_domain::error::DomainError::new(
                    atm_domain::error::ErrorCode::STORE_BUSY,
                    "注入：提交之后的读繁忙",
                )
            })
        })));
    let (status, v) = rest(
        &w,
        "POST",
        &format!("/api/v1/projects/{}/objectives", w.project),
        &json!({"session": w.session, "title": "after-commit"}).to_string(),
    );
    assert_eq!(
        (status, &v["committed"], &v["fix"]["kind"]),
        (503, &json!(true), &json!("reread")),
        "{v}"
    );
    assert!(
        v["fix"]["call"]["arguments"]["op_id"]
            .as_str()
            .unwrap()
            .starts_with("auto:"),
        "{v}"
    );
    let objectives: i64 = w
        .svc
        .store()
        .read(|tx| {
            tx.query_row(
                "SELECT count(*) FROM objectives WHERE title = 'after-commit'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(objectives, 1);
}

// ---- 没有工具的路由 --------------------------------------------------------------------------------

#[test]
fn own_routes_cover_what_the_tools_do_not() {
    let w = world("rest-own");
    let base = format!("/api/v1/projects/{}", w.project);

    let (status, text) = http(w.port, "GET", "/api/v1/system/status", "");
    assert_eq!(status, 200, "{text}");
    let s = parse(&text);
    assert_eq!(
        (s["impl"].clone(), s["layout"].clone()),
        (json!("rust"), json!("single"))
    );
    assert_eq!(s["version"], "3.0.0-test", "运行时补的字段：{text}");
    assert_eq!(s["conversion"]["phase"], "PUBLISHED");
    assert_eq!(s["project_count"], 1);

    let (status, text) = http(w.port, "GET", "/api/v1/projects", "");
    assert_eq!(status, 200, "{text}");
    assert_eq!(parse(&text)["projects"][0]["code"], w.project);
    let (status, text) = http(w.port, "GET", &base, "");
    assert_eq!(status, 200, "{text}");
    assert_eq!(parse(&text)["code"], w.project);

    let (status, text) = http(w.port, "GET", "/api/v1/backups?limit=5", "");
    assert_eq!(status, 200, "{text}");
    assert_eq!(parse(&text)["scope"], "store");

    let (status, text) = http(
        w.port,
        "POST",
        "/api/v1/imports/agenttask-md/preview",
        &json!({"project": w.project, "content": "# 计划\n\n- [ ] 第一步\n", "sourceName": "agenttask.md"}).to_string(),
    );
    assert_eq!(status, 200, "{text}");
    assert!(parse(&text)["sha256"].is_string(), "{text}");

    let (status, text) = http(
        w.port,
        "POST",
        &format!("{base}/objectives"),
        &json!({"session": w.session, "title": "上线", "definitionOfDone": ["发布"]}).to_string(),
    );
    assert_eq!(status, 201, "{text}");
    let objective = parse(&text);
    assert_eq!(objective["objective"]["title"], "上线", "{text}");
    let objective_id = objective["objective"]["id"].as_str().unwrap().to_owned();
    let (status, text) = http(
        w.port,
        "POST",
        &format!("{base}/milestones"),
        &json!({"session": w.session, "objective_id": objective_id, "title": "第一阶段"})
            .to_string(),
    );
    assert_eq!(status, 201, "{text}");

    let (status, text) = http(
        w.port,
        "POST",
        "/api/v1/quick-tasks",
        &json!({"title": "顺手记一下", "actor": "codex", "op_id": "rest-quick"}).to_string(),
    );
    assert_eq!(status, 201, "{text}");
    let quick = parse(&text)["result"].clone();
    let (status, text) = http(w.port, "GET", "/api/v1/quick-tasks?status=open", "");
    assert_eq!(status, 200, "{text}");
    assert_eq!(parse(&text)["quick_tasks"].as_array().unwrap().len(), 1);
    let id = quick["quick"]["id"].as_str().unwrap().to_owned();
    let version = quick["quick"]["version"].as_i64().unwrap();
    let (status, text) = http(
        w.port,
        "POST",
        &format!("/api/v1/quick-tasks/{id}/promote"),
        &json!({"expectedVersion": version, "targetProjectCode": w.project, "session": w.session})
            .to_string(),
    );
    assert_eq!(status, 200, "{text}");
    assert_eq!(parse(&text)["operation"], "quick.promote");

    // 逗号分隔的列表：只要这两种事件。
    let (status, text) = http(
        w.port,
        "GET",
        &format!("{base}/events?types=objective.created,milestone.created"),
        "",
    );
    assert_eq!(status, 200, "{text}");
    let kinds: Vec<String> = parse(&text)["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["type"].as_str().unwrap().to_owned())
        .collect();
    assert!(
        kinds
            .iter()
            .all(|k| k == "objective.created" || k == "milestone.created")
            && kinds.contains(&"objective.created".to_owned())
            && kinds.contains(&"milestone.created".to_owned()),
        "{text}"
    );

    let (status, text) = http(w.port, "GET", &format!("{base}/events?limit=2"), "");
    assert_eq!(status, 200, "{text}");
    let page = parse(&text);
    assert_eq!(page["events"].as_array().unwrap().len(), 2, "{text}");
    assert!(page["current_sequence"].as_i64().unwrap() >= 2);
}

// ---- T-HINT -------------------------------------------------------------------------------------

/// delta 放不下的那一条：`oversized_event.continuation.path` 原样 GET，得到的就是那条完整事件。
#[test]
fn the_oversized_event_hint_resolves() {
    let w = world("rest-hint-delta");
    let seq: i64 = w
        .svc
        .store()
        .read(|tx| {
            tx.query_row(
                "SELECT project_seq FROM projects WHERE id = ?1",
                [&w.project_id],
                |r| r.get(0),
            )
        })
        .unwrap();
    let big = "大".repeat(5000);
    let pid = w.project_id.clone();
    w.svc
        .store()
        .write(move |tx| {
            tx.execute(
                "INSERT INTO events (project_id, seq, id, type, actor_type, actor_id, aggregate_type, aggregate_id, payload_json, created_at)
                 VALUES (?1, ?2, 'EVBIG', 'work.updated', 'AGENT', 'claude', 'WORK_ITEM', 'X', ?3, '2026-10-07T00:00:00.000Z')",
                rusqlite::params![pid, seq + 1, json!({"summary": big}).to_string()],
            )?;
            tx.execute(
                "UPDATE projects SET project_seq = ?2 WHERE id = ?1",
                rusqlite::params![pid, seq + 1],
            )
        })
        .unwrap();
    let d = call(
        &w,
        "memory",
        "atm_delta",
        json!({"project": w.project, "since_seq": seq, "max_chars": 1000}),
    )["structuredContent"]
        .clone();
    let hint = &d["oversized_event"]["continuation"];
    assert_eq!(
        (hint["method"].clone(), hint["transport"].clone()),
        (json!("GET"), json!("REST")),
        "{d}"
    );
    let path = hint["path"].as_str().unwrap();
    let (status, text) = http(w.port, "GET", path, "");
    assert_eq!(status, 200, "{path}: {text}");
    let page = parse(&text);
    let event = &page["events"][0];
    assert_eq!(event["seq"], seq + 1);
    assert_eq!(event["seq"], d["oversized_event"]["seq"]);
    let full = "大".repeat(5000);
    assert!(
        event["summary"].as_str().unwrap().contains(&full),
        "{event}"
    );
    assert_eq!(page["events"].as_array().unwrap().len(), 1);
}

/// `CANDIDATE_HASH_MISMATCH` 的 `request_lookup.path` 原样 GET，得到的就是那条 review 请求。
#[test]
fn the_review_request_hint_resolves() {
    let w = world("rest-hint-review");
    let a = agent();
    let created = w
        .svc
        .create_work_items(
            &a,
            &Target::new(&w.project_id, Some(&w.session), "rv-create"),
            vec![
                CreateItem {
                    title: "被审任务".into(),
                    acceptance: vec!["过评审".into()],
                    checklist: vec![NewChecklist {
                        title: "独立评审".into(),
                        ..NewChecklist::default()
                    }],
                    ..CreateItem::default()
                },
                CreateItem {
                    title: "评审".into(),
                    acceptance: vec!["给出结论".into()],
                    parent_ref: Some("1".into()),
                    kind: Some("REVIEW".into()),
                    ..CreateItem::default()
                },
            ],
        )
        .unwrap();
    let parent = created.result["items"][0]["key"]
        .as_str()
        .unwrap()
        .to_owned();
    let review = created.result["items"][1]["key"]
        .as_str()
        .unwrap()
        .to_owned();
    let checklist = created.result["checklist"][&parent][0]
        .as_str()
        .unwrap()
        .to_owned();
    let requested = w
        .svc
        .request_review(
            &a,
            &Target::new(&w.project_id, Some(&w.session), "rv-request"),
            ReviewRequest {
                review_task_key: review.clone(),
                expected_review_task_version: Some(1),
                parent_checklist_id: checklist.clone(),
                expected_parent_checklist_version: 0,
                candidate_hashes: vec![("source".into(), "abcdef1".into())],
            },
        )
        .unwrap();
    let request_key = requested.result["request"]["key"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut begin = BeginRequest::new("codex");
    begin.selector.code = Some(w.project.clone());
    begin.role = Some("REVIEWER".into());
    begin.op_id = Some("rv-begin".into());
    let reviewer = w.svc.begin(&a, begin).unwrap().result["session"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    call(
        &w,
        "actions",
        "atm_task_patch",
        json!({"session": reviewer, "task_key": review, "operation": "start", "expected_version": 1}),
    );
    let e = w
        .svc
        .submit_review(
            &a,
            &Target::new(&w.project_id, Some(&reviewer), "rv-submit"),
            ReviewSubmit {
                request_key: request_key.clone(),
                review_task_key: Some(review.clone()),
                expected_review_task_version: Some(2),
                verdict: Verdict::Approved,
                reviewed_hashes: vec![("source".into(), "1234567".into())],
                evidence: vec![Evidence::Item {
                    kind: EvidenceKind::TestResult,
                    value: "评审通过".into(),
                    note: None,
                }],
            },
        )
        .unwrap_err();
    assert_eq!(
        e.code,
        atm_domain::error::ErrorCode::CANDIDATE_HASH_MISMATCH
    );
    let lookup = &e.details["request_lookup"];
    assert_eq!(lookup["method"], "GET");
    let path = lookup["path"].as_str().unwrap();
    let (status, text) = http(w.port, "GET", path, "");
    assert_eq!(status, 200, "{path}: {text}");
    let got = parse(&text);
    assert_eq!(got["key"], request_key);
    assert_eq!(got["key"], e.details["request_key"]);
    assert_eq!(got["review_task_key"], review);
    assert_eq!(got["parent_task_key"], parent);
    assert_eq!(got["parent_checklist_id"], checklist);
    assert_eq!(
        got["expected_candidate_hashes"],
        json!([{"name": "source", "value": "abcdef1"}])
    );
    assert_eq!(got["submission"], Value::Null);
    // 不存在的 key：带出路的 404，不是「没有这个入口」。
    let (status, text) = http(
        w.port,
        "GET",
        &format!(
            "/api/v1/projects/{}/reviews/requests/{}-RR-0099",
            w.project, w.project
        ),
        "",
    );
    assert_eq!(status, 404, "{text}");
    assert_eq!(parse(&text)["code"], "REVIEW_REQUEST_NOT_FOUND");
}

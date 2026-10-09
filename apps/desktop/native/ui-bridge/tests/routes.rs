//! 界面路由表的守卫（06 T-UI、10 R8）。
//!
//! 1. 表与 06 §2 的总表（`atm_http::rest::ROUTES`）一致：每条都是总表里处置为 U / U\* / A+U 的那条（编号、方法、路径），
//!    总表里这三种处置的路由都在表里，例外只有登记过的改方法（#27）。
//! 2. 表与 `packages/client` 实际发出的请求一致：客户端里每个 `/api/v1/` 调用要么在表里，要么登记为 Agent 专用 /
//!    已删除（并写明 06 的编号），表里每条（W7 的派单与同步也在）客户端都有调用。

use atm_http::rest::{Disp, ROUTES};
use atm_ui_bridge::routes::{METHOD_CHANGED, UI_ROUTES};
use std::collections::BTreeSet;
use std::path::Path;

#[test]
fn the_table_is_the_ui_part_of_the_route_inventory() {
    let ui_dispositions = |d: Disp| matches!(d, Disp::U | Disp::UStar(_) | Disp::Au);
    for route in UI_ROUTES {
        let source = ROUTES
            .iter()
            .find(|r| r.n == route.n)
            .unwrap_or_else(|| panic!("#{} is not in the 06 inventory", route.n));
        assert!(
            ui_dispositions(source.disp),
            "#{} is {:?} in 06",
            route.n,
            source.disp
        );
        assert_eq!(source.path, route.path, "#{}", route.n);
        let method = METHOD_CHANGED
            .iter()
            .find(|(n, _)| *n == route.n)
            .map_or(source.method, |(_, m)| *m);
        assert_eq!(method, route.method, "#{}", route.n);
    }
    let mut numbers: Vec<u16> = UI_ROUTES.iter().map(|r| r.n).collect();
    numbers.sort_unstable();
    numbers.dedup();
    assert_eq!(numbers.len(), UI_ROUTES.len(), "a route is listed twice");
    for source in ROUTES.iter().filter(|r| ui_dispositions(r.disp)) {
        assert!(
            UI_ROUTES.iter().any(|r| r.n == source.n),
            "#{} {} {} is missing from the UI table",
            source.n,
            source.method,
            source.path
        );
    }
}

/// 客户端里的 `"METHOD", "/api/v1/…"` 或模板字符串：`${encodeURIComponent(x)}` 记成 `:x`，`${queryString(…)}` 去掉。
fn client_calls(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for method in ["GET", "POST", "PUT", "PATCH", "DELETE"] {
        let needle = format!("\"{method}\",");
        let mut from = 0;
        while let Some(at) = text[from..].find(&needle) {
            let start = from + at + needle.len();
            from = start;
            let rest = text[start..].trim_start();
            let Some(quote) = rest.chars().next().filter(|c| *c == '"' || *c == '`') else {
                continue;
            };
            let body = &rest[1..];
            let Some(end) = body.find(quote) else {
                continue;
            };
            let raw = &body[..end];
            if !raw.starts_with("/api/v1/") {
                continue;
            }
            out.push((method.to_owned(), template_path(raw)));
        }
    }
    out
}

fn template_path(raw: &str) -> String {
    let mut out = String::new();
    let mut rest = raw;
    while let Some(at) = rest.find("${") {
        out.push_str(&rest[..at]);
        let inner_start = at + 2;
        let mut depth = 1;
        let mut end = inner_start;
        for (i, c) in rest[inner_start..].char_indices() {
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = inner_start + i;
                        break;
                    }
                }
                _ => {}
            }
        }
        let expr = &rest[inner_start..end];
        if let Some(arg) = expr
            .strip_prefix("encodeURIComponent(")
            .and_then(|e| e.strip_suffix(')'))
        {
            out.push(':');
            out.push_str(arg.trim());
        } else if !expr.starts_with("queryString(") {
            out.push_str("${?}");
        }
        rest = &rest[end + 1..];
    }
    out.push_str(rest);
    out
}

/// 只比形状：参数名不同不算不同（客户端写 `encodeURIComponent(code)`，06 写 `:code`）。
fn shape(path: &str) -> String {
    path.split('/')
        .map(|s| if s.starts_with(':') { ":" } else { s })
        .collect::<Vec<_>>()
        .join("/")
}

/// 客户端有、界面表没有的调用：Agent 专用或已删除的路由（06 的编号与处置）。
const NOT_UI: &[(&str, &str, &str)] = &[
    ("GET", "/api/v1/projects/:", "#16 A：Agent 读单个项目"),
    ("POST", "/api/v1/projects/:/paths", "#17 删除"),
    (
        "POST",
        "/api/v1/projects/:/objectives",
        "#51 A：Agent 建目标",
    ),
    (
        "POST",
        "/api/v1/projects/:/milestones",
        "#52 A：Agent 建里程碑",
    ),
    ("PATCH", "/api/v1/saved-views/:", "#7 删除"),
    ("GET", "/api/v1/projects/:/records/:", "#34 删除"),
    (
        "GET",
        "/api/v1/projects/:/work-items",
        "#64 A：Agent 任务列表",
    ),
    (
        "POST",
        "/api/v1/projects/:/work-items",
        "#65 A：Agent 建任务",
    ),
    (
        "POST",
        "/api/v1/projects/:/work-items/patch",
        "#66 A：Agent 改任务",
    ),
    ("PATCH", "/api/v1/projects/:/checklist/:", "#73 删除"),
    (
        "POST",
        "/api/v1/projects/:/progress-updates",
        "#74 A：Agent 写进度",
    ),
    ("POST", "/api/v1/projects/:/records", "#75 A：Agent 写记录"),
    ("POST", "/api/v1/sessions", "#80 A：begin"),
    ("POST", "/api/v1/sessions/:/close", "#81 A：end"),
];

#[test]
fn the_table_matches_what_the_client_calls() {
    let client = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../packages/client/src");
    let mut files = vec![client.join("index.ts")];
    for entry in std::fs::read_dir(client.join("surfaces")).unwrap() {
        files.push(entry.unwrap().path());
    }
    let mut calls = BTreeSet::new();
    for f in &files {
        let text = std::fs::read_to_string(f).unwrap();
        for (m, p) in client_calls(&text) {
            calls.insert((m, shape(&p)));
        }
    }
    assert!(
        calls.len() > 60,
        "the scan found only {} calls: {calls:?}",
        calls.len()
    );
    let table: BTreeSet<(String, String)> = UI_ROUTES
        .iter()
        .map(|r| (r.method.to_owned(), shape(r.path)))
        .collect();
    let not_ui: BTreeSet<(String, String)> = NOT_UI
        .iter()
        .map(|(m, p, _)| ((*m).to_owned(), (*p).to_owned()))
        .collect();
    let unexplained: Vec<_> = calls
        .iter()
        .filter(|c| !table.contains(*c) && !not_ui.contains(*c))
        .collect();
    assert!(
        unexplained.is_empty(),
        "client calls outside the table: {unexplained:?}"
    );
    let unused: Vec<_> = table.iter().filter(|t| !calls.contains(*t)).collect();
    assert!(
        unused.is_empty(),
        "table routes the client never calls: {unused:?}"
    );
    let stale: Vec<_> = not_ui.iter().filter(|t| !calls.contains(*t)).collect();
    assert!(
        stale.is_empty(),
        "NOT_UI lists calls the client no longer makes: {stale:?}"
    );
}

#[test]
fn the_client_scan_reads_templates() {
    let text = r#"request<A<B>>("GET", `/api/v1/projects/${encodeURIComponent(code)}/milestones${queryString({ objective })}`),
                  request("POST", "/api/v1/projects", input)"#;
    assert_eq!(
        client_calls(text),
        vec![
            (
                "GET".to_owned(),
                "/api/v1/projects/:code/milestones".to_owned()
            ),
            ("POST".to_owned(), "/api/v1/projects".to_owned()),
        ]
    );
}

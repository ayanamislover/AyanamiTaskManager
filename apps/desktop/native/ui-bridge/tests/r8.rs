//! 10 R8 的负例：目标、方法、大小、主体的核对都在分发之前，什么都没碰到服务。

mod support;

use serde_json::json;
use support::{agent, error, world};

#[test]
fn targets_that_are_not_relative_api_paths_are_refused() {
    let w = world("r8-targets");
    for target in [
        "http://127.0.0.1:1/api/v1/projects",
        "https://atm.localhost/api/v1/projects",
        "//evil/api/v1/projects",
        "api/v1/projects",
        "/api/v2/projects",
        "/api/v1//projects",
        "/api/v1/projects/../settings",
        "/api/v1/projects/%2e%2e/settings",
        "/api/v1/projects/a%2Fb/objectives",
        "/api/v1/projects/a%5Cb/objectives",
        "/api/v1/projects/%zz/objectives",
        "/api/v1/projects/./objectives",
        "/api/v1/projects#x",
        "\\api\\v1\\projects",
    ] {
        let r = w.call("GET", target, None);
        error(&r, 400, "INVALID_ARGUMENT");
    }
    let long = format!("/api/v1/projects?q={}", "x".repeat(5000));
    error(&w.call("GET", &long, None), 400, "INVALID_ARGUMENT");
}

#[test]
fn paths_and_methods_outside_the_table_are_refused() {
    let w = world("r8-table");
    // 不在表里的路径：Agent 专用的、删除的、不存在的。
    for target in [
        "/api/v1/sessions",
        "/api/v1/projects/ATM/work-items",
        "/api/v1/projects/ATM/projection/reconcile",
        "/api/v1/system/projections/reconcile",
        "/api/v1/mcp/core",
        "/api/v1/nothing",
    ] {
        let r = w.call("POST", target, Some(json!({})));
        assert!(
            r.status == 404 || r.status == 405,
            "{target}: {} {}",
            r.status,
            r.body
        );
    }
    error(&w.call("GET", "/api/v1/nothing", None), 404, "NOT_FOUND");
    error(
        &w.call("POST", "/api/v1/projects/ATM/projection/reconcile", None),
        404,
        "NOT_FOUND",
    );
    // 路径对、方法不对。
    error(
        &w.call("DELETE", "/api/v1/projects", None),
        405,
        "METHOD_NOT_ALLOWED",
    );
    error(
        &w.call("GET", "/api/v1/exports/ATM", None),
        405,
        "METHOD_NOT_ALLOWED",
    );
    error(
        &w.call("TRACE", "/api/v1/projects", None),
        405,
        "METHOD_NOT_ALLOWED",
    );
}

#[test]
fn bodies_are_bounded_and_must_be_json_objects() {
    let w = world("r8-bodies");
    let huge = vec![b' '; atm_ui_bridge::MAX_BODY_BYTES + 1];
    let r = w.ui.dispatch(
        &support::user(),
        atm_ui_bridge::Request {
            method: "POST",
            target: "/api/v1/projects",
            body: Some(&huge),
        },
    );
    error(&r, 413, "INVALID_ARGUMENT");
    for body in [&b"[1,2]"[..], b"\"x\"", b"{", b"null"] {
        let r = w.ui.dispatch(
            &support::user(),
            atm_ui_bridge::Request {
                method: "POST",
                target: "/api/v1/projects",
                body: Some(body),
            },
        );
        error(&r, 400, "INVALID_ARGUMENT");
    }
    // 没有项目被建出来。
    assert_eq!(w.get("/api/v1/projects"), json!([]));
}

#[test]
fn only_the_user_reaches_the_ui_api() {
    let w = world("r8-principal");
    let r = w.call_as(&agent(), "GET", "/api/v1/projects", None);
    error(&r, 403, "USER_AUTHORIZATION_REQUIRED");
    let r = w.call_as(
        &agent(),
        "POST",
        "/api/v1/projects",
        Some(json!({ "name": "x", "sourcePath": null })),
    );
    error(&r, 403, "USER_AUTHORIZATION_REQUIRED");
    assert_eq!(w.get("/api/v1/projects"), json!([]));
}

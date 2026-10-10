//! 界面版 `/system/status`（06 #1、07 §7）：单库的健康加运行时给的转换状态，2.0 的读法不变。
//! 数据源冲突时入口不开、界面调用由宿主答 SOURCE_CONFLICT（`host/src/app.rs` 的 `unavailable_in`）。

mod support;

use serde_json::json;
use support::{agent, error, world};

#[test]
fn status_is_the_single_database_health_and_the_conversion_state() {
    let w = world("status");
    w.project("甲", "STA");
    w.project("乙", "STB");
    let s = w.get("/api/v1/system/status");
    assert_eq!(s["ok"], true, "{s}");
    assert_eq!(s["impl"], "rust");
    assert_eq!(s["layout"], "single");
    // 转换状态原样来自运行时（宿主给的是发布物的 generation）。
    assert_eq!(
        s["conversion"],
        json!({ "phase": "PUBLISHED", "generation": "G-test" })
    );
    assert_eq!(s["version"], "3.0.0-test");
    // 单库：没有逐库失败；2.0 的 `{生命周期: {total, failed}}` 照旧给。
    assert_eq!(s["projectCount"], 2);
    assert_eq!(
        s["projectCounts"]["ACTIVE"],
        json!({ "total": 2, "failed": 0 })
    );
    assert_eq!(s["projectFailures"], json!([]));
    assert_eq!(s["sqlite"]["ok"], true);
    assert!(s["sqlite"]["sqliteVersion"].is_string(), "{s}");
    assert_eq!(s["startedAt"], support::STARTED);

    // Agent 主体到不了界面接口。
    let r = w.call_as(&agent(), "GET", "/api/v1/system/status", None);
    error(&r, 403, "USER_AUTHORIZATION_REQUIRED");
}

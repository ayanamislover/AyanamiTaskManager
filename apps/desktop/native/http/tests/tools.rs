//! W4c 工具面（surface v6）：tools/list 逐字节快照、U-5、U-7、M-03。
//!
//! 快照在 `tests/snapshots/tools-list-<profile>.json`。有意修改工具面时用
//! `ATM_UPDATE_SNAPSHOTS=1 cargo test -p atm-http --test tools` 重写，并在提交里说明为什么变。

use atm_http::mcp::Profile;
use atm_http::schema::{Field, Ty};
use atm_http::tools::PROFILES;
use serde_json::Value;
use std::collections::BTreeSet;

fn profile(name: &str) -> &'static Profile {
    PROFILES.iter().find(|p| p.name == name).unwrap()
}

fn names(tools: &[&atm_http::schema::Tool]) -> Vec<&'static str> {
    tools.iter().map(|t| t.name).collect()
}

/// 逐字节快照：任何说明、参数、上限、注解的变化都要显式改快照。
#[test]
fn tools_list_matches_the_snapshot() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/snapshots");
    let update = std::env::var_os("ATM_UPDATE_SNAPSHOTS").is_some();
    for p in &PROFILES {
        let text = serde_json::to_string_pretty(&p.tools_json()).unwrap() + "\n";
        let path = dir.join(format!("tools-list-{}.json", p.name));
        if update {
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(&path, &text).unwrap();
            continue;
        }
        let want = std::fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!("{}: {e} (run with ATM_UPDATE_SNAPSHOTS=1)", path.display())
        });
        assert!(
            text == want,
            "tools/list of {} differs from {}",
            p.name,
            path.display()
        );
    }
    assert!(
        !update,
        "snapshots rewritten; rerun without ATM_UPDATE_SNAPSHOTS"
    );
}

/// M-03 与 R11：发布的工具正好是这些，没有 U-only 能力；旧名只能调用、不发布。
#[test]
fn each_profile_publishes_exactly_its_tools() {
    assert_eq!(
        names(profile("core").tools),
        [
            "atm_begin",
            "atm_brief",
            "atm_task_list",
            "atm_task_get",
            "atm_task_create",
            "atm_task_patch",
            "atm_progress_add",
            "atm_record",
            "atm_end"
        ]
    );
    assert_eq!(
        names(profile("memory").tools),
        [
            "atm_search",
            "atm_knowledge_search",
            "atm_knowledge_get",
            "atm_knowledge_save"
        ]
    );
    assert_eq!(names(profile("actions").tools), ["atm_task_patch"]);
    for p in &PROFILES {
        let listed: BTreeSet<_> = p
            .tools_json()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_owned())
            .collect();
        for old in ["atm_delta", "atm_feedback"] {
            assert!(!listed.contains(old), "{} lists {old}", p.name);
            assert_eq!(
                p.find(old).map(|t| t.name),
                Some(old),
                "{} cannot call {old}",
                p.name
            );
        }
    }
    // actions 是 core 的别名：core 的每个工具都能在 actions 上调用。
    for t in profile("core").tools {
        assert!(profile("actions").find(t.name).is_some(), "{}", t.name);
    }
    // U-only 能力（恢复审批、生命周期、备份、设置、知识归档与管理编辑）不在任何 profile 上。
    for p in &PROFILES {
        for t in p.tools.iter().chain(p.hidden) {
            for banned in [
                "restore",
                "trash",
                "archive",
                "backup",
                "setting",
                "lifecycle",
                "approve",
                "purge",
            ] {
                assert!(!t.name.contains(banned), "{} exposes {}", p.name, t.name);
            }
        }
    }
}

/// U-7：合并后 core 不超过 2.0 core + actions；memory、actions 不超过 2.0 的单 profile 预算。
#[test]
fn every_profile_fits_its_byte_budget() {
    for p in &PROFILES {
        // 数字写死：常量被改大时这条要变红（2.0 core 8,016 + actions 8,164；单 profile 10,240 − 512）。
        let want = if p.name == "core" { 16_180 } else { 9_728 };
        assert_eq!(p.budget, want, "{}", p.name);
        assert!(
            p.bytes() <= p.budget,
            "{}: {} > {}",
            p.name,
            p.bytes(),
            p.budget
        );
    }
}

/// 不用 `$ref` / `$defs`（去重会让客户端把枚举渲染成 `{}`）；说明单行；annotations 与 `_meta` 齐全。
#[test]
fn published_tools_are_self_contained() {
    for p in &PROFILES {
        for t in p.tools_json() {
            let text = t.to_string();
            assert!(
                !text.contains("$ref") && !text.contains("$defs"),
                "{}",
                t["name"]
            );
            let d = t["description"].as_str().unwrap();
            assert!(
                !d.contains('\n') && !d.starts_with(char::is_whitespace),
                "{}",
                t["name"]
            );
            assert!(t["annotations"]["readOnlyHint"].is_boolean());
            assert!(t["annotations"]["destructiveHint"].is_boolean());
            assert_eq!(t["_meta"]["surface_version"], "v6");
            assert_eq!(t["_meta"]["schema_hash"].as_str().unwrap().len(), 16);
            assert_eq!(t["inputSchema"]["type"], "object");
        }
    }
}

/// U-5：只留属性名（丢掉 enum、required、default、maxLength）时，description 里仍然有每个必填项、
/// 每个枚举值和每个上限。
#[test]
fn descriptions_survive_a_stripped_schema() {
    fn walk(d: &str, tool: &str, path: &str, f: &Field) {
        if f.hidden {
            return;
        }
        let mut ty = &f.ty;
        let mut path = path.to_owned();
        if let Ty::List { of, max } = ty {
            if *max > 0 {
                assert!(
                    d.contains(&format!("{path} 最多 {max} 项")),
                    "{tool}: {path} max items"
                );
            }
            if let Some(c) = f.compact {
                // 紧凑发布的列表：每项与顶层同形，字段已经在顶层说明过。
                assert!(
                    d.contains(&format!("{path} 每项{c}")),
                    "{tool}: {path} compact"
                );
                return;
            }
            path.push_str("[]");
            ty = of;
        }
        match ty {
            Ty::Str { max } | Ty::Text { max } if *max > 0 => {
                assert!(d.contains(&format!("{path}≤{max}")), "{tool}: {path}≤{max}")
            }
            Ty::Int { min: 0, max } if *max == i64::MAX => {}
            Ty::Int { min, max } => {
                let want = if *max == i64::MAX {
                    format!("{path}≥{min}")
                } else {
                    format!("{path}={min}–{max}")
                };
                assert!(d.contains(&want), "{tool}: {want}");
            }
            Ty::Enum(values) | Ty::EnumPlus(values, _) | Ty::BoolOr(values) => {
                for v in *values {
                    assert!(d.contains(v), "{tool}: {path}={v}");
                }
            }
            Ty::Obj(fields) | Ty::TextOr { obj: fields, .. } => {
                for c in fields.iter().filter(|c| !c.hidden) {
                    if c.required {
                        assert!(d.contains(c.name), "{tool}: required {path}.{}", c.name);
                    }
                    walk(d, tool, &format!("{path}.{}", c.name), c);
                }
            }
            _ => {}
        }
    }
    for p in &PROFILES {
        for t in p.tools.iter().chain(p.hidden) {
            let d = t.description();
            for f in t.fields.iter().filter(|f| !f.hidden) {
                if f.required {
                    assert!(d.contains(f.name), "{}: required {}", t.name, f.name);
                }
                walk(&d, t.name, f.name, f);
            }
        }
    }
}

/// task_patch：单条写顶层、多条放 items，二者不能同时用；operation 的旧名照收不改写。
#[test]
fn task_patch_accepts_one_item_flat_or_many_in_items() {
    let patch = profile("core").find("atm_task_patch").unwrap();
    let flat = patch
        .validate(&serde_json::json!({"key": "ATM-T-1", "op": "Complete", "note": "done"}))
        .unwrap();
    assert_eq!(flat.args["task_key"], "ATM-T-1");
    assert_eq!(flat.args["operation"], "complete");
    let batch = patch
        .validate(&serde_json::json!({"items": [
            {"task_key": "ATM-T-1", "operation": "start"},
            {"task_key": "ATM-T-2", "operation": "CHECKLIST_SINGLE", "checklist_items": [{"id": "C1", "status": "done"}]}
        ]}))
        .unwrap();
    assert_eq!(batch.args["items"][1]["operation"], "checklist_single");
    assert_eq!(batch.args["items"][1]["checklist"][0]["item"], "C1");
    assert_eq!(batch.args["items"][1]["checklist"][0]["status"], "DONE");
    let both = patch
        .validate(&serde_json::json!({"task_key": "A", "operation": "start", "items": [{"task_key": "B", "operation": "start"}]}))
        .unwrap_err();
    assert!(
        both.problems
            .iter()
            .all(|p| p.allowed == Some(Value::from("items"))),
        "{both:?}"
    );
    let neither = patch
        .validate(&serde_json::json!({"note": "x"}))
        .unwrap_err();
    let missing: Vec<_> = neither.problems.iter().map(|p| p.path.as_str()).collect();
    assert_eq!(missing, ["operation", "task_key"]);
}

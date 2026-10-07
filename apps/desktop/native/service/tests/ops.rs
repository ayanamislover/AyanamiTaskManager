//! operation 映射表（10 R11 A3）：表与源码里的 `*_OPERATION` 常量逐项对得上，各列与规格的条文一致。

use atm_domain::principal::PrincipalKind;
use atm_service::ops::{self, Namespace, OPS, TargetKind};
use std::collections::BTreeSet;
use std::path::Path;

/// 源码里声明的全部 operation 常量的值。
fn declared() -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut stack = vec![Path::new(env!("CARGO_MANIFEST_DIR")).join("src")];
    while let Some(dir) = stack.pop() {
        for e in std::fs::read_dir(&dir).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            let text = std::fs::read_to_string(&p).unwrap();
            for line in text.lines() {
                let line = line.trim();
                if let Some(rest) = line.strip_prefix("pub const ")
                    && let Some((name, value)) = rest.split_once(": &str = \"")
                    && name.ends_with("_OPERATION")
                {
                    out.insert(value.trim_end_matches("\";").to_owned());
                }
            }
        }
    }
    out
}

/// 每个常量都登记了，表里也没有不存在的 operation，没有重复。
#[test]
fn the_table_covers_every_operation_constant() {
    let declared = declared();
    // 阳性对照：扫描本身要扫到东西（正则写错会让两边都是空集而永远相等）。
    assert!(declared.len() >= 30, "{declared:?}");
    assert!(declared.contains("session.recover-or-begin"));
    let table: BTreeSet<String> = OPS.iter().map(|o| o.operation.to_owned()).collect();
    assert_eq!(table.len(), OPS.len(), "duplicate rows");
    let missing: Vec<_> = declared.difference(&table).collect();
    let extra: Vec<_> = table.difference(&declared).collect();
    assert!(
        missing.is_empty() && extra.is_empty(),
        "missing {missing:?}, extra {extra:?}"
    );
    for op in OPS {
        assert!(!op.capabilities.is_empty(), "{}", op.operation);
        assert!(!op.targets.is_empty(), "{}", op.operation);
        assert_eq!(ops::find(op.operation), Some(op));
    }
    assert_eq!(ops::find("no.such-operation"), None);
}

/// A3 的条文：调用索引只有三个；需要 session 的列从能力推出；只有全 NONE 的才免 resolve。
#[test]
fn the_columns_follow_the_spec() {
    let indexed: BTreeSet<&str> = OPS
        .iter()
        .filter(|o| o.indexed)
        .map(|o| o.operation)
        .collect();
    assert_eq!(
        indexed,
        BTreeSet::from([
            "project.create",
            "quick.promote",
            "session.recover-or-begin"
        ])
    );
    let get = |name: &str| ops::find(name).unwrap();
    for (name, needs) in [
        ("session.recover-or-begin", false),
        ("project.create", false),
        ("quick.create", false),
        ("quick.update", false),
        ("quick.promote", false),
        ("knowledge.agent-save", true),
        ("work.progress", true),
        ("project-update.publish", true),
        ("record.create", true),
        ("work.patch.batch", true),
        ("session.end", true),
    ] {
        assert_eq!(get(name).agent_needs_session(), needs, "{name}");
    }
    // Agent 用不了的入口能力不影响这一列（项目级进度的 User 发布能力不需要 session）。
    assert!(
        !atm_domain::capability::Capability::ProjectUpdatePublish
            .grant()
            .agent_needs_session
    );
    let exempt: BTreeSet<&str> = OPS
        .iter()
        .filter(|o| o.always_none())
        .map(|o| o.operation)
        .collect();
    for name in ["quick.create", "quick.update"] {
        assert!(exempt.contains(name), "{name}");
    }
    for name in [
        "session.recover-or-begin",
        "project.create",
        "quick.promote",
    ] {
        assert!(!exempt.contains(name), "{name}");
    }
    assert_eq!(
        get("session.recover-or-begin").targets,
        &[TargetKind::None, TargetKind::Project, TargetKind::Create]
    );
    assert_eq!(get("project.create").targets, &[TargetKind::Create]);
    assert_eq!(
        get("quick.promote").targets,
        &[TargetKind::Project, TargetKind::Create]
    );
    assert_eq!(
        get("knowledge.agent-save").targets,
        &[TargetKind::Knowledge]
    );
    assert_eq!(get("quick.create").targets, &[TargetKind::None]);
}

/// 幂等命名空间由 operation 与可信主体决定，不由客户端选。
#[test]
fn namespaces_follow_the_operation_and_principal() {
    let get = |name: &str| ops::find(name).unwrap();
    use PrincipalKind::{Agent, User};
    assert_eq!(
        ops::namespace(get("session.recover-or-begin"), Agent, false, false),
        Namespace::Call
    );
    assert_eq!(
        ops::namespace(get("project.create"), Agent, true, false),
        Namespace::Call
    );
    assert_eq!(
        ops::namespace(get("quick.promote"), Agent, false, false),
        Namespace::Call
    );
    // 带目标的晋升落点固定，按普通写入定位。
    assert_eq!(
        ops::namespace(get("quick.promote"), Agent, false, true),
        Namespace::Actor
    );
    assert_eq!(
        ops::namespace(get("work.patch.batch"), Agent, true, false),
        Namespace::Session
    );
    assert_eq!(
        ops::namespace(get("work.patch.batch"), User, true, false),
        Namespace::Actor
    );
    assert_eq!(
        ops::namespace(get("quick.create"), Agent, false, false),
        Namespace::Actor
    );
}

//! W4c 描述表驱动的 schema 与校验器（R11 P1-4；11 §5 U-5）。

use atm_domain::error::ProblemKind;
use atm_http::schema::{Field, Renamed, Tool, Ty};
use serde_json::{Value, json};

static ITEM: [Field; 2] = [
    Field::new("title", Ty::Text { max: 200 }).required(),
    Field::new(
        "depends_on",
        Ty::List {
            of: &Ty::Str { max: 64 },
            max: 20,
        },
    ),
];

static FIELDS: [Field; 7] = [
    Field::new("task_key", Ty::Str { max: 64 })
        .required()
        .aliases(&["key", "work_item_key"]),
    Field::new("operation", Ty::Enum(&["start", "complete", "wait_user"]))
        .required()
        .aliases(&["op"]),
    Field::new("summary", Ty::Str { max: 10 }).aliases(&["content"]),
    Field::new("limit", Ty::Int { min: 1, max: 100 }).default("10"),
    Field::new("ready_only", Ty::Bool),
    Field::new("resume", Ty::BoolOr(&["auto"])).default("\"auto\""),
    Field::new(
        "items",
        Ty::List {
            of: &Ty::Obj(&ITEM),
            max: 3,
        },
    ),
];

static TOOL: Tool = Tool {
    name: "atm_demo",
    summary: "演示工具。",
    fields: &FIELDS,
    check: None,
    read_only: true,
    destructive: false,
};

fn problems(args: Value) -> Vec<(String, ProblemKind, Option<String>)> {
    TOOL.validate(&args)
        .unwrap_err()
        .problems
        .into_iter()
        .map(|p| (p.path, p.problem, p.did_you_mean))
        .collect()
}

/// 别名改成规范名并记录；枚举不分大小写；显式 null 视同省略；数字字符串与 "true" 收下。
#[test]
fn aliases_cases_and_nulls_are_normalized() {
    let ok = TOOL
        .validate(&json!({
            "key": "ATM-T-1", "OP": "Complete", "content": "done", "summary": null,
            "limit": "5", "ready_only": "TRUE", "resume": "Auto",
        }))
        .unwrap();
    assert_eq!(
        Value::Object(ok.args),
        json!({"task_key": "ATM-T-1", "operation": "complete", "summary": "done",
               "limit": 5, "ready_only": true, "resume": "auto"})
    );
    assert_eq!(
        ok.normalized,
        vec![
            Renamed {
                from: "OP".into(),
                to: "operation".into()
            },
            Renamed {
                from: "content".into(),
                to: "summary".into()
            },
            Renamed {
                from: "key".into(),
                to: "task_key".into()
            },
        ]
    );
    // 同一字段给了规范名和别名：值相同就收下，不同就是冲突。
    assert!(
        TOOL.validate(&json!({"task_key": "A", "key": "A", "operation": "start"}))
            .is_ok()
    );
    assert_eq!(
        problems(json!({"task_key": "A", "key": "B", "operation": "start"})),
        vec![("key".into(), ProblemKind::Conflict, None)]
    );
    // resume 也收布尔。
    let ok = TOOL
        .validate(&json!({"task_key": "A", "operation": "start", "resume": false}))
        .unwrap();
    assert_eq!(ok.args["resume"], false);
}

/// 未知键与拼错的枚举带 did_you_mean；全部可自动更正时给出更正后的完整参数。
#[test]
fn guesses_get_did_you_mean_and_a_corrected_call() {
    let r = TOOL
        .validate(&json!({"taskkey": "ATM-T-1", "operation": "complet", "sumary": "x"}))
        .unwrap_err();
    let got: Vec<_> = r
        .problems
        .iter()
        .map(|p| (p.path.as_str(), p.problem, p.did_you_mean.as_deref()))
        .collect();
    assert_eq!(
        got,
        vec![
            ("operation", ProblemKind::Enum, Some("complete")),
            ("sumary", ProblemKind::Unknown, Some("summary")),
            ("taskkey", ProblemKind::Unknown, Some("task_key")),
        ]
    );
    assert_eq!(
        r.corrected.map(Value::Object),
        Some(json!({"operation": "complete", "summary": "x", "task_key": "ATM-T-1"}))
    );
    // 太远的猜法没有建议，也就没有更正。
    let r = TOOL
        .validate(&json!({"task_key": "A", "operation": "start", "zzzzzz": 1}))
        .unwrap_err();
    assert_eq!(r.problems[0].did_you_mean, None);
    assert_eq!(
        r.problems[0].allowed,
        Some(json!([
            "task_key",
            "operation",
            "summary",
            "limit",
            "ready_only",
            "resume",
            "items"
        ]))
    );
    assert_eq!(r.corrected, None);
    // 缺必填项无从更正。
    let r = TOOL.validate(&json!({"operation": "start"})).unwrap_err();
    assert_eq!(
        (r.problems[0].path.as_str(), r.problems[0].problem),
        ("task_key", ProblemKind::Missing)
    );
    assert_eq!(r.corrected, None);
}

/// 有界数值越界时夹到边界（U-3）；没有上限的不猜。
#[test]
fn bounded_numbers_are_clamped_and_unbounded_ones_are_not() {
    // 有界的数值越界：夹到边界，可以自动更正（fix.call 就是夹过的同一调用）。
    let r = TOOL
        .validate(&json!({"task_key": "A", "operation": "start", "limit": 500}))
        .unwrap_err();
    assert_eq!(r.problems[0].did_you_mean.as_deref(), Some("100"));
    assert_eq!(r.corrected.unwrap()["limit"], json!(100));
    let r = TOOL
        .validate(&json!({"task_key": "A", "operation": "start", "limit": 0}))
        .unwrap_err();
    assert_eq!(r.corrected.unwrap()["limit"], json!(1));
    // 没有上限的（版本号）不猜：负数照样拒绝，不给更正。
    let r = atm_http::tools::TASK_PATCH
        .validate(
            &json!({"task_key": "A", "operation": "edit", "expected_version": -1, "title": "x"}),
        )
        .unwrap_err();
    assert_eq!(r.problems[0].problem, ProblemKind::Pattern);
    assert_eq!(r.problems[0].did_you_mean, None);
    assert_eq!(r.corrected, None);
}

/// 只剩「不起作用的参数」时，更正就是去掉它们的同一调用（U-3）；与别的组合规则问题同时出现就不猜。
#[test]
fn unused_parameters_are_dropped_by_the_correction() {
    let search = &atm_http::tools::SEARCH;
    let r = search
        .validate(&json!({"project": "P", "query": "登录", "session": "S"}))
        .unwrap_err();
    assert_eq!(r.problems[0].problem, ProblemKind::Unused);
    assert_eq!(
        r.corrected.map(Value::Object),
        Some(json!({"project": "P", "query": "登录"}))
    );
    let r = search
        .validate(&json!({"project": "P", "list": "records", "session": "S"}))
        .unwrap_err();
    assert_eq!(
        r.corrected.map(Value::Object),
        Some(json!({"project": "P", "list": "records"}))
    );
    // 没有 project 时列表的 session 用来推出项目，不是多余的。
    assert!(
        search
            .validate(&json!({"list": "records", "session": "S"}))
            .is_ok()
    );
    // list 与 query 同时给是真冲突：不知道调用方要哪一种，不给更正。
    let r = search
        .validate(&json!({"project": "P", "list": "records", "query": "x", "session": "S"}))
        .unwrap_err();
    assert_eq!(r.corrected, None);
}

/// 给出的更正一定能通过同一次校验：去掉一个「不起作用」的参数后反而缺了必填项时，不给更正。
#[test]
fn a_correction_that_would_not_pass_is_withheld() {
    static FIELDS: [Field; 2] = [
        Field::new("a", Ty::Str { max: 10 }).required(),
        Field::new("b", Ty::Bool),
    ];
    // 故意写错的组合规则：有 b 就说 a 不起作用。去掉 a 之后缺必填项。
    fn check(args: &serde_json::Map<String, Value>) -> Vec<atm_domain::error::Problem> {
        if args.contains_key("b") {
            vec![atm_domain::error::Problem::new("a", ProblemKind::Unused)]
        } else {
            Vec::new()
        }
    }
    static T: Tool = Tool {
        name: "atm_withheld",
        summary: "演示。",
        fields: &FIELDS,
        check: Some(check),
        read_only: true,
        destructive: false,
    };
    let r = T.validate(&json!({"a": "x", "b": true})).unwrap_err();
    assert_eq!(r.problems[0].problem, ProblemKind::Unused);
    assert_eq!(r.corrected, None);
}

/// R1-P1-01：字段更正（夹取、别名）之后组合规则照样要看。能一并更正的一次给全，有真冲突就不给；
/// 给出的更正一定能通过校验。
#[test]
fn field_corrections_still_meet_the_combination_rules() {
    let search = &atm_http::tools::SEARCH;
    // 夹取 + 不起作用的 session：一次更正两处。
    let r = search
        .validate(&json!({"project": "P", "session": "S", "list": "records", "limit": 50}))
        .unwrap_err();
    let corrected = Value::Object(r.corrected.expect("夹取与去掉 session 都能确定"));
    assert_eq!(
        corrected,
        json!({"project": "P", "list": "records", "limit": 30})
    );
    assert!(search.validate(&corrected).is_ok(), "{corrected}");
    // 夹取 + list 与 query 的真冲突：不给更正。
    let r = search
        .validate(&json!({"project": "P", "list": "records", "query": "x", "limit": 50}))
        .unwrap_err();
    assert_eq!(r.corrected, None, "{:?}", r.problems);
    assert!(
        r.problems
            .iter()
            .any(|p| p.problem == ProblemKind::Conflict && p.path == "query"),
        "{:?}",
        r.problems
    );
}

/// 上限、类型、嵌套路径。
#[test]
fn limits_types_and_nested_paths() {
    let base = |extra: Value| {
        let mut v = json!({"task_key": "A", "operation": "start"});
        v.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        v
    };
    let r = TOOL
        .validate(&base(json!({"summary": "一二三四五六七八九十十"})))
        .unwrap_err();
    assert_eq!(
        (r.problems[0].problem, r.problems[0].over_by),
        (ProblemKind::TooLong, Some(1))
    );
    assert_eq!(
        problems(base(json!({"limit": 0})))[0].1,
        ProblemKind::Pattern
    );
    assert_eq!(
        problems(base(json!({"limit": "many"})))[0].1,
        ProblemKind::Pattern
    );
    assert_eq!(
        problems(base(json!({"ready_only": "yes"})))[0].1,
        ProblemKind::Pattern
    );
    assert_eq!(
        problems(base(
            json!({"items": [{"title": "a"}, {"title": " "}, {"titel": "c", "depends_on": "1"}]})
        )),
        vec![
            ("items[1].title".into(), ProblemKind::Empty, None),
            (
                "items[2].titel".into(),
                ProblemKind::Unknown,
                Some("title".into())
            ),
        ]
    );
    assert_eq!(
        problems(base(
            json!({"items": [{"title": "a"}, {"title": "b"}, {"title": "c"}, {"title": "d"}]})
        ))[0]
            .1,
        ProblemKind::TooMany
    );
    // 单个元素不包数组也收下。
    let ok = TOOL
        .validate(&base(json!({"items": {"title": "a", "depends_on": "1"}})))
        .unwrap();
    assert_eq!(
        ok.args["items"],
        json!([{"title": "a", "depends_on": ["1"]}])
    );
    // 数字当文本传来照字面收下。
    let ok = TOOL
        .validate(&json!({"task_key": 42, "operation": "start"}))
        .unwrap();
    assert_eq!(ok.args["task_key"], "42");
    // 参数整体不是对象。
    assert_eq!(problems(json!([1]))[0].0, "$");
    assert!(TOOL.validate(&Value::Null).is_err());
}

/// U-5：客户端丢掉 schema 里的 enum / required / default 之后，description 里仍有每个必填项、
/// 枚举值和上限。
#[test]
fn the_description_carries_what_clients_drop() {
    let d = TOOL.description();
    assert!(!d.contains('\n'), "{d}");
    for needle in [
        "必填：task_key、operation",
        "operation=start|complete|wait_user",
        "summary≤10",
        "limit=1–100，默认 10",
        "resume=true|false|auto，默认 auto",
        "items 最多 3 项",
        "items[] 每项必填 title",
        "items[].title≤200",
        "items[].depends_on 最多 20 项",
        "items[].depends_on[]≤64",
    ] {
        assert!(d.contains(needle), "{needle} missing from:\n{d}");
    }
}

/// schema：不用 $ref、不写 additionalProperties；只有类型、枚举与必填。
#[test]
fn the_schema_is_flat_and_complete() {
    let s = TOOL.input_schema();
    let text = s.to_string();
    assert!(
        !text.contains("$ref") && !text.contains("additionalProperties"),
        "{text}"
    );
    assert_eq!(s["required"], json!(["task_key", "operation"]));
    assert_eq!(
        s["properties"]["operation"]["enum"],
        json!(["start", "complete", "wait_user"])
    );
    // 上限、默认值只在 description（U-5），schema 里只有类型、枚举与必填。
    for word in [
        "maxLength",
        "minLength",
        "minimum",
        "maximum",
        "maxItems",
        "default",
    ] {
        assert!(!text.contains(word), "{word} in {text}");
    }
    assert_eq!(s["properties"]["summary"], json!({"type": "string"}));
    assert_eq!(s["properties"]["limit"], json!({"type": "integer"}));
    assert_eq!(
        s["properties"]["resume"],
        json!({"enum": [true, false, "auto"]})
    );
    assert_eq!(
        s["properties"]["items"]["items"]["required"],
        json!(["title"])
    );
}

/// nullable 字段的显式 null 是「清空」，原样保留；schema 写成 [类型, "null"]。其余字段的 null 视同省略。
#[test]
fn nullable_fields_keep_an_explicit_null() {
    static NULLABLE: [Field; 2] = [
        Field::new("parent_key", Ty::Str { max: 100 }).nullable(),
        Field::new("title", Ty::Text { max: 400 }),
    ];
    static T: Tool = Tool {
        name: "atm_nullable",
        summary: "演示。",
        fields: &NULLABLE,
        check: None,
        read_only: false,
        destructive: false,
    };
    let ok = T
        .validate(&json!({"parent_key": null, "title": null}))
        .unwrap();
    assert_eq!(Value::Object(ok.args), json!({"parent_key": null}));
    let ok = T.validate(&json!({"parent_key": "ATM-T-1"})).unwrap();
    assert_eq!(ok.args["parent_key"], "ATM-T-1");
    let s = T.input_schema();
    assert_eq!(
        s["properties"]["parent_key"]["type"],
        json!(["string", "null"])
    );
    assert_eq!(s["properties"]["title"]["type"], "string");
}

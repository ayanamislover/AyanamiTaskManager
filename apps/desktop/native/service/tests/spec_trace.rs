//! 规格追溯检查（09 §4；W2h2）。
//!
//! 输入三样：
//! - `trace/rules.tsv`：从规格抽出的编号快照（规格目录不进仓库；`output/w2-evidence/spec-trace-extract.py --check`
//!   负责确认快照没过期）；
//! - 工作区 domain / store / service / http / jobs / host / ui-bridge / runtime / cli / agents / sync / dispatch 里全部 `#[test]` 函数：测试名里的 `w052`、`s080`、`p005`、`l112` 这类 token 自动算作覆盖；
//! - `TRACE.md` 的映射表：测试名里没带编号的覆盖、被裁决取代的规则、留给后续阶段的去向。
//!
//! 失败条件：
//! - 某个编号既没有用例也没有去向；
//! - 已覆盖的编号，用例里找不到反例（拒绝、错误）或成功路径的痕迹，映射表说明里也没写「反例：」「成功例：」指到具体断言；
//! - 测试名引用了不存在的编号；
//! - 映射表写了不存在的编号或用例，或者结论写法不对；
//! - TRACE.md 里生成的 D01–D35 矩阵和汇总与当前计算结果不一致（`ATM_TRACE_BLESS=1` 重写）。
//! - 去向指向已经过了关口的阶段（[`PHASES_DONE`]）。

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

/// 已经过了关口的阶段（W3–W7）：表里再写 `PARTIAL(Wn)` / `DEFERRED(Wn)` 且 n 不大于它，就是把没做完的
/// 留在了已经关上的阶段里（W6i 验收：TRACE 无 DEFERRED(W6) / PARTIAL(W6)；W7e 验收：无 DEFERRED(W7) / PARTIAL(W7)）。
const PHASES_DONE: u8 = 7;

/// 去向指向已经关上的阶段。
fn stale(verdict: &Verdict) -> Option<u8> {
    match verdict {
        Verdict::Partial(n) | Verdict::Deferred(n) if *n <= PHASES_DONE => Some(*n),
        _ => None,
    }
}

const MAP_BEGIN: &str = "<!-- trace:map -->";
const MAP_END: &str = "<!-- /trace:map -->";
const GEN_BEGIN: &str = "<!-- trace:generated -->";
const GEN_END: &str = "<!-- /trace:generated -->";

/// 反例的痕迹：调用被拒、断言出错。
const REFUSAL_MARKERS: &[&str] = &[
    "refused(",
    "expect_err(",
    "unwrap_err(",
    ".is_err()",
    "Err(",
    "ErrorCode::",
    "assert_ne!",
    "assert!(!",
    "is_none()",
    "None)",
];
/// 成功路径的痕迹。
const SUCCESS_MARKERS: &[&str] = &[".unwrap()", "Ok(", ".expect(", ".is_ok()", "Some("];

struct Rule {
    ds: Vec<String>,
    title: String,
}

struct TestFn {
    path: String,
    name: String,
    refusal: bool,
    success: bool,
}

#[derive(Clone, PartialEq, Eq, Debug)]
enum Verdict {
    Covered,
    Partial(u8),
    Superseded(String),
    Deferred(u8),
    Na,
}

struct MapRow {
    verdict: Verdict,
    tests: Vec<String>,
    note: String,
}

fn native() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

fn read(p: &Path) -> String {
    fs::read_to_string(p)
        .unwrap_or_else(|e| panic!("{}: {e}", p.display()))
        .replace("\r\n", "\n")
}

fn load_rules() -> BTreeMap<String, Rule> {
    let text = read(&native().join("service/trace/rules.tsv"));
    let mut out = BTreeMap::new();
    for line in text.lines().filter(|l| !l.is_empty()) {
        let mut cols = line.splitn(3, '\t');
        let (id, ds, title) = (cols.next().unwrap(), cols.next(), cols.next());
        let (Some(ds), Some(title)) = (ds, title) else {
            panic!("rules.tsv: malformed line {line:?}");
        };
        let ds = ds
            .split(',')
            .filter(|d| !d.is_empty())
            .map(str::to_owned)
            .collect();
        let prev = out.insert(
            id.to_owned(),
            Rule {
                ds,
                title: title.to_owned(),
            },
        );
        assert!(prev.is_none(), "rules.tsv: duplicate {id}");
    }
    out
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            if p.file_name().is_some_and(|n| n != "target" && n != "data") {
                rust_files(&p, out);
            }
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

/// `#[test]` 之后（允许夹着别的属性）的第一个 `fn 名字(`；函数体取到下一个 `#[test]` 为止。
fn load_tests() -> Vec<TestFn> {
    let root = native();
    let mut files = Vec::new();
    for krate in [
        "domain",
        "store",
        "service",
        "http",
        "jobs",
        "host",
        "ui-bridge",
        "runtime",
        "cli",
        "agents",
        "sync",
        "dispatch",
    ] {
        rust_files(&root.join(krate), &mut files);
    }
    files.sort();
    let mut out = Vec::new();
    for file in files {
        let text = read(&file);
        let rel = file
            .strip_prefix(&root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let lines: Vec<&str> = text.lines().collect();
        let starts: Vec<usize> = (0..lines.len())
            .filter(|&i| lines[i].trim() == "#[test]")
            .collect();
        for (n, &start) in starts.iter().enumerate() {
            let end = starts.get(n + 1).copied().unwrap_or(lines.len());
            let Some(name) = lines[start + 1..end].iter().find_map(|l| {
                let l = l.trim_start();
                let rest = l
                    .strip_prefix("fn ")
                    .or_else(|| l.strip_prefix("async fn "))?;
                Some(rest.split(['(', '<']).next().unwrap().trim().to_owned())
            }) else {
                panic!("{rel}:{}: #[test] without a fn", start + 1);
            };
            let body = lines[start..end].join("\n");
            out.push(TestFn {
                path: rel.clone(),
                name,
                refusal: REFUSAL_MARKERS.iter().any(|m| body.contains(m)),
                success: SUCCESS_MARKERS.iter().any(|m| body.contains(m)),
            });
        }
    }
    out
}

/// 测试名里的规则 token：`w052` → `W-052`；`c12`、`r11`、`q01` 是裁决编号，只校验存在（各节重名，覆盖靠映射表）。
enum Token {
    Rule(String),
    Decision(String),
}

fn tokens(name: &str) -> Vec<Token> {
    let mut out = Vec::new();
    for t in name.split('_') {
        let (head, digits) = t.split_at(t.find(|c: char| c.is_ascii_digit()).unwrap_or(t.len()));
        if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        match (head, digits.len()) {
            ("w" | "s" | "p" | "l", 3) => out.push(Token::Rule(format!(
                "{}-{digits}",
                head.to_ascii_uppercase()
            ))),
            ("c" | "q", 2) => out.push(Token::Decision(format!(
                "{}-{digits}",
                head.to_ascii_uppercase()
            ))),
            ("cl", 2) => out.push(Token::Decision(format!("C-L{digits}"))),
            ("r", 1 | 2) => out.push(Token::Decision(format!("R{digits}"))),
            _ => {}
        }
    }
    out
}

fn decision_exists(rules: &BTreeMap<String, Rule>, short: &str) -> bool {
    rules.keys().any(|k| {
        k.split_once('/').is_some_and(|(_, rest)| {
            rest == short
                || rest
                    .strip_prefix(short)
                    .is_some_and(|tail| tail.starts_with(['′', '″', '‴', '.']))
        })
    })
}

fn parse_verdict(s: &str) -> Option<Verdict> {
    let phase = |inner: &str| -> Option<u8> {
        let n: u8 = inner.strip_prefix('W')?.parse().ok()?;
        (3..=8).contains(&n).then_some(n)
    };
    let arg = |prefix: &str| s.strip_prefix(prefix).and_then(|r| r.strip_suffix(')'));
    match s {
        "COVERED" => Some(Verdict::Covered),
        "NA" => Some(Verdict::Na),
        _ => {
            if let Some(a) = arg("PARTIAL(") {
                phase(a).map(Verdict::Partial)
            } else if let Some(a) = arg("DEFERRED(") {
                phase(a).map(Verdict::Deferred)
            } else {
                arg("SUPERSEDED(")
                    .filter(|a| !a.is_empty())
                    .map(|a| Verdict::Superseded(a.to_owned()))
            }
        }
    }
}

fn cells(line: &str) -> Vec<String> {
    let inner = line.trim().trim_start_matches('|').trim_end_matches('|');
    inner.split(" | ").map(|c| c.trim().to_owned()).collect()
}

fn load_map(trace: &str, errors: &mut Vec<String>) -> BTreeMap<String, MapRow> {
    let body = trace
        .split_once(MAP_BEGIN)
        .and_then(|(_, rest)| rest.split_once(MAP_END))
        .map(|(b, _)| b)
        .expect("TRACE.md: map markers missing");
    let mut out = BTreeMap::new();
    for line in body
        .lines()
        .filter(|l| l.starts_with("| ") && !l.starts_with("| ---") && !l.starts_with("| 编号"))
    {
        let c = cells(line);
        if c.len() != 4 {
            errors.push(format!("TRACE.md: row needs 4 cells: {line}"));
            continue;
        }
        let id = c[0].trim_matches('`').to_owned();
        let Some(verdict) = parse_verdict(&c[1]) else {
            errors.push(format!("TRACE.md {id}: bad verdict {:?}", c[1]));
            continue;
        };
        let tests = c[2]
            .split(['、', ','])
            .map(|t| t.trim().trim_matches('`').to_owned())
            .filter(|t| !t.is_empty() && t != "—")
            .collect();
        let row = MapRow {
            verdict,
            tests,
            note: c[3].clone(),
        };
        if out.insert(id.clone(), row).is_some() {
            errors.push(format!("TRACE.md: duplicate row {id}"));
        }
    }
    out
}

#[derive(Default)]
struct Resolved {
    tests: BTreeSet<String>,
    verdict: Option<Verdict>,
}

#[test]
fn every_rule_is_traced_to_tests_or_a_later_phase() {
    let rules = load_rules();
    let tests = load_tests();
    let trace_path = native().join("service/TRACE.md");
    let trace = read(&trace_path);
    let mut errors = Vec::new();
    let map = load_map(&trace, &mut errors);

    let by_ref: BTreeMap<String, &TestFn> = tests
        .iter()
        .map(|t| (format!("{}::{}", t.path, t.name), t))
        .collect();
    let mut resolved: BTreeMap<String, Resolved> = BTreeMap::new();

    for t in &tests {
        for tok in tokens(&t.name) {
            match tok {
                Token::Rule(id) if rules.contains_key(&id) => {
                    resolved
                        .entry(id)
                        .or_default()
                        .tests
                        .insert(format!("{}::{}", t.path, t.name));
                }
                Token::Rule(id) => {
                    errors.push(format!("{}::{} names unknown rule {id}", t.path, t.name))
                }
                Token::Decision(d) if decision_exists(&rules, &d) => {}
                Token::Decision(d) => {
                    errors.push(format!("{}::{} names unknown decision {d}", t.path, t.name))
                }
            }
        }
    }
    for (id, row) in &map {
        if !rules.contains_key(id) || id.starts_with('D') {
            errors.push(format!("TRACE.md: unknown id {id}"));
            continue;
        }
        if let Verdict::Superseded(by) = &row.verdict
            && !rules.contains_key(by)
        {
            errors.push(format!("TRACE.md {id}: superseded by unknown id {by}"));
        }
        if matches!(
            row.verdict,
            Verdict::Deferred(_) | Verdict::Na | Verdict::Superseded(_)
        ) && row.note.is_empty()
        {
            errors.push(format!("TRACE.md {id}: {:?} needs a note", row.verdict));
        }
        if let Some(n) = stale(&row.verdict) {
            errors.push(format!(
                "TRACE.md {id}: {:?} points at W{n}, which has passed its gate",
                row.verdict
            ));
        }
        let entry = resolved.entry(id.clone()).or_default();
        for r in &row.tests {
            if by_ref.contains_key(r) {
                entry.tests.insert(r.clone());
            } else {
                errors.push(format!("TRACE.md {id}: no such test {r}"));
            }
        }
        entry.verdict = Some(row.verdict.clone());
    }

    for id in rules.keys().filter(|k| !k.starts_with('D')) {
        let Some(r) = resolved.get(id) else {
            errors.push(format!(
                "{id} ({}) has no test and no entry in TRACE.md",
                rules[id].title
            ));
            continue;
        };
        let needs_tests = !matches!(r.verdict, Some(Verdict::Deferred(_) | Verdict::Na));
        if needs_tests && r.tests.is_empty() {
            errors.push(format!("{id}: {:?} without tests", r.verdict));
            continue;
        }
        if needs_tests {
            // 机械判定不了的（纯函数断言没有 unwrap / Err 痕迹），映射表的说明里必须写明反例或成功例落在哪条断言上。
            let note = map.get(id).map_or("", |m| m.note.as_str());
            let fns: Vec<&TestFn> = r.tests.iter().map(|t| by_ref[t]).collect();
            if !fns.iter().any(|t| t.refusal) && !note.contains("反例：") {
                errors.push(format!("{id}: no counterexample among {:?}", r.tests));
            }
            if !fns.iter().any(|t| t.success) && !note.contains("成功例：") {
                errors.push(format!("{id}: no success path among {:?}", r.tests));
            }
        }
    }

    let generated = render(&rules, &resolved);
    let current = trace
        .split_once(GEN_BEGIN)
        .and_then(|(_, rest)| rest.split_once(GEN_END))
        .map(|(b, _)| b.to_owned());
    if current.as_deref() != Some(generated.as_str()) {
        if std::env::var_os("ATM_TRACE_BLESS").is_some() {
            let (head, tail) = match trace.split_once(GEN_BEGIN) {
                Some((h, rest)) => (
                    h.to_owned(),
                    rest.split_once(GEN_END)
                        .map(|(_, t)| t.to_owned())
                        .unwrap_or_default(),
                ),
                None => (format!("{}\n", trace.trim_end()), "\n".to_owned()),
            };
            fs::write(
                &trace_path,
                format!("{head}{GEN_BEGIN}{generated}{GEN_END}{tail}"),
            )
            .unwrap();
        } else {
            errors
                .push("TRACE.md: generated matrix is stale (rerun with ATM_TRACE_BLESS=1)".into());
        }
    }

    assert!(
        errors.is_empty(),
        "{} trace problems:\n{}",
        errors.len(),
        errors.join("\n")
    );
}

fn short(v: &Option<Verdict>) -> String {
    match v {
        None | Some(Verdict::Covered) => String::new(),
        Some(Verdict::Partial(n)) => format!("（余 W{n}）"),
        Some(Verdict::Deferred(n)) => format!("→W{n}"),
        Some(Verdict::Superseded(by)) => format!("（由 {by} 改写）"),
        Some(Verdict::Na) => "（NA）".into(),
    }
}

fn render(rules: &BTreeMap<String, Rule>, resolved: &BTreeMap<String, Resolved>) -> String {
    let mut s = String::from(
        "\n\n## D01–D35 矩阵（生成）\n\n| D | 检查项 | 规则 | 用例数 |\n| --- | --- | --- | --- |\n",
    );
    for (d, rule) in rules.iter().filter(|(k, _)| k.starts_with('D')) {
        let ids: Vec<&String> = rules
            .iter()
            .filter(|(_, r)| r.ds.contains(d))
            .map(|(k, _)| k)
            .collect();
        let tests: BTreeSet<&String> = ids
            .iter()
            .filter_map(|i| resolved.get(*i))
            .flat_map(|r| &r.tests)
            .collect();
        let list: Vec<String> = ids
            .iter()
            .map(|i| {
                format!(
                    "{i}{}",
                    short(&resolved.get(*i).and_then(|r| r.verdict.clone()))
                )
            })
            .collect();
        s.push_str(&format!(
            "| {d} | {} | {} | {} |\n",
            rule.title,
            list.join("、"),
            tests.len()
        ));
    }
    let mut groups: BTreeMap<&str, BTreeMap<&str, usize>> = BTreeMap::new();
    for id in rules.keys().filter(|k| !k.starts_with('D')) {
        let group = match id.split_once('/') {
            Some((g, _)) => {
                if g == "10" {
                    "10 裁决"
                } else {
                    "00 裁决"
                }
            }
            None => &id[..1],
        };
        let v = resolved.get(id).and_then(|r| r.verdict.clone());
        let kind = match v {
            None | Some(Verdict::Covered) => "已覆盖",
            Some(Verdict::Partial(_)) => "部分覆盖，余下后续阶段",
            Some(Verdict::Superseded(_)) => "按裁决改写后覆盖",
            Some(Verdict::Deferred(_)) => "后续阶段",
            Some(Verdict::Na) => "无可测行为",
        };
        *groups.entry(group).or_default().entry(kind).or_default() += 1;
    }
    s.push_str("\n## 汇总（生成）\n\n| 组 | 去向 | 条数 |\n| --- | --- | --- |\n");
    for (g, kinds) in &groups {
        for (k, n) in kinds {
            s.push_str(&format!("| {g} | {k} | {n} |\n"));
        }
    }
    s.push('\n');
    s
}

/// 阳性对照：指向已经关上的阶段的去向认得出来，后续阶段与其他结论放行。
#[test]
fn a_verdict_on_a_closed_phase_is_recognised() {
    for (text, closed) in [
        ("PARTIAL(W6)", Some(6)),
        ("DEFERRED(W6)", Some(6)),
        ("PARTIAL(W3)", Some(3)),
        ("DEFERRED(W7)", Some(7)),
        ("PARTIAL(W7)", Some(7)),
        ("DEFERRED(W8)", None),
        ("PARTIAL(W8)", None),
        ("COVERED", None),
        ("NA", None),
    ] {
        let v = parse_verdict(text).unwrap();
        assert_eq!(stale(&v), closed, "{text}");
    }
}

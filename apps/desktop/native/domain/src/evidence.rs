//! 证据与候选哈希的格式（01 W-010、W-011）。需要查库的部分（atm_record / atm_task 改写成
//! 规范 key，W-012）在服务里，这里只做纯格式校验与规范化。

use crate::error::{Problem, ProblemKind};
use crate::text::{js_trim, utf16_len};
use serde::Serialize;
use serde_json::json;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceKind {
    GitSha,
    AtmRecord,
    AtmTask,
    TestResult,
    Url,
    File,
}

impl EvidenceKind {
    pub const ALL: [&'static str; 6] = [
        "git_sha",
        "atm_record",
        "atm_task",
        "test_result",
        "url",
        "file",
    ];

    pub fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "git_sha" => EvidenceKind::GitSha,
            "atm_record" => EvidenceKind::AtmRecord,
            "atm_task" => EvidenceKind::AtmTask,
            "test_result" => EvidenceKind::TestResult,
            "url" => EvidenceKind::Url,
            "file" => EvidenceKind::File,
            _ => return None,
        })
    }
}

/// 一条证据：字符串，或 `{kind, value, note?}`（对象里的多余键由入参层丢弃）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum Evidence {
    Text(String),
    Item {
        kind: EvidenceKind,
        value: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
}

/// 各入口对证据条数的上限（W-011）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EvidenceSite {
    /// 检查项：0–100 条，字符串与对象都可以。
    Checklist,
    /// 任务进度：0–20 条。
    Progress,
    /// Review 提交：1–100 条，只能是对象。
    ReviewSubmit,
}

pub const TEXT_MAX: usize = 2000;
pub const NOTE_MAX: usize = 500;

/// 校验并 trim（JS 语义）。返回规范化后的证据，或全部问题。
pub fn validate(
    path: &str,
    site: EvidenceSite,
    items: Vec<Evidence>,
) -> Result<Vec<Evidence>, Vec<Problem>> {
    let (min, max) = match site {
        EvidenceSite::Checklist => (0, 100),
        EvidenceSite::Progress => (0, 20),
        EvidenceSite::ReviewSubmit => (1, 100),
    };
    let mut problems = Vec::new();
    if items.len() < min {
        problems.push(Problem::new(path, ProblemKind::TooFew).allowed(json!({ "min": min })));
    }
    if items.len() > max {
        problems.push(Problem::new(path, ProblemKind::TooMany).over_by(items.len() - max));
    }
    let mut out = Vec::with_capacity(items.len());
    for (i, item) in items.into_iter().enumerate() {
        let at = format!("{path}[{i}]");
        match item {
            Evidence::Text(text) => {
                if site == EvidenceSite::ReviewSubmit {
                    problems.push(
                        Problem::new(&at, ProblemKind::Pattern)
                            .got(text.clone())
                            .allowed(json!({ "kind": EvidenceKind::ALL, "value": "string" })),
                    );
                }
                let text = js_trim(&text).to_owned();
                bounded(&mut problems, &at, &text, 1, TEXT_MAX);
                out.push(Evidence::Text(text));
            }
            Evidence::Item { kind, value, note } => {
                let value = js_trim(&value).to_owned();
                bounded(&mut problems, &format!("{at}.value"), &value, 1, TEXT_MAX);
                let note = note.map(|n| js_trim(&n).to_owned());
                if let Some(n) = &note {
                    bounded(&mut problems, &format!("{at}.note"), n, 0, NOTE_MAX);
                }
                out.push(Evidence::Item { kind, value, note });
            }
        }
    }
    if problems.is_empty() {
        Ok(out)
    } else {
        Err(problems)
    }
}

fn bounded(problems: &mut Vec<Problem>, path: &str, text: &str, min: usize, max: usize) {
    let len = utf16_len(text);
    if len < min {
        problems.push(Problem::new(path, ProblemKind::Empty));
    } else if len > max {
        problems.push(Problem::new(path, ProblemKind::TooLong).over_by(len - max));
    }
}

pub const HASHES_MAX: usize = 20;
pub const HASH_NAME_MAX: usize = 64;

/// W-010：候选哈希规范化。name 与 value 都 trim、转小写，按 name 排序（ASCII 名下即字节序）。
/// name 匹配 `^[a-z][a-z0-9_.:-]*$`、1–64；value 匹配 `^[a-f0-9]{7,128}$`；1–20 项；
/// name 忽略大小写后不得重复。存储与比较都用规范化结果，提交时逐字节比较。
pub fn normalize_hashes(
    path: &str,
    pairs: Vec<(String, String)>,
) -> Result<Vec<(String, String)>, Vec<Problem>> {
    let mut problems = Vec::new();
    if pairs.is_empty() {
        problems.push(Problem::new(path, ProblemKind::TooFew).allowed(json!({ "min": 1 })));
    }
    if pairs.len() > HASHES_MAX {
        problems.push(Problem::new(path, ProblemKind::TooMany).over_by(pairs.len() - HASHES_MAX));
    }
    let mut out: Vec<(String, String)> = Vec::with_capacity(pairs.len());
    for (name, value) in pairs {
        let name_n = js_trim(&name).to_ascii_lowercase();
        let value_n = js_trim(&value).to_ascii_lowercase();
        let at = format!("{path}.{name}");
        let name_ok = utf16_len(&name_n) <= HASH_NAME_MAX
            && name_n
                .bytes()
                .next()
                .is_some_and(|b| b.is_ascii_lowercase())
            && name_n
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_.:-".contains(&b));
        if !name_ok {
            problems.push(Problem::new(&at, ProblemKind::Pattern).got(name.clone()));
        }
        let value_ok = (7..=128).contains(&value_n.len())
            && value_n
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if !value_ok {
            problems.push(Problem::new(&at, ProblemKind::Pattern).got(value.clone()));
        }
        if out.iter().any(|(n, _)| *n == name_n) {
            problems.push(Problem::new(&at, ProblemKind::Duplicate).got(name.clone()));
        }
        out.push((name_n, value_n));
    }
    if !problems.is_empty() {
        return Err(problems);
    }
    out.sort();
    Ok(out)
}

/// CANDIDATE_HASH_MISMATCH 的差异（W-059 第 7 步；字段顺序有意义，先放可操作的差异）。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct HashDiff {
    pub missing: Vec<String>,
    pub extra: Vec<String>,
    pub mismatch: Vec<HashMismatch>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct HashMismatch {
    pub name: String,
    pub bound: String,
    pub submitted: String,
}

/// 两组都已规范化。逐字节相等时 None。
pub fn diff_hashes(bound: &[(String, String)], submitted: &[(String, String)]) -> Option<HashDiff> {
    if bound == submitted {
        return None;
    }
    let find = |set: &[(String, String)], name: &str| {
        set.iter().find(|(n, _)| n == name).map(|(_, v)| v.clone())
    };
    let mut diff = HashDiff::default();
    for (name, value) in bound {
        match find(submitted, name) {
            None => diff.missing.push(name.clone()),
            Some(s) if s != *value => diff.mismatch.push(HashMismatch {
                name: name.clone(),
                bound: value.clone(),
                submitted: s,
            }),
            Some(_) => {}
        }
    }
    for (name, _) in submitted {
        if find(bound, name).is_none() {
            diff.extra.push(name.clone());
        }
    }
    Some(diff)
}

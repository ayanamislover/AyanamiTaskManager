//! 公开 key 的格式化与解析（01 W-001、W-009、W-012；00 C-11、C-15）。
//!
//! - 所有 key 入参先 trim（JS 语义）再转大写（00 C-15，放宽方向：2.x 区分大小写的旧调用照样能解析）。
//! - 编号部分只认 ASCII 数字，按数值比较，补零位数不限（`ATM-T-12` 与 `ATM-T-0012` 是同一项），
//!   超过 JS 安全整数的不认。
//! - 解析只看格式与项目代码；「这个编号的行是否存在」由服务按 `(project_id, local_no)` 查，
//!   所以另一个项目的 key 永远解析不到本项目的行。

use crate::text::js_trim;

/// JS `Number.MAX_SAFE_INTEGER`。
pub const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// C-15：trim 后转大写。
pub fn normalize(input: &str) -> String {
    js_trim(input).to_uppercase()
}

pub fn task_key(project_code: &str, local_no: i64) -> String {
    format!("{project_code}-T-{local_no:04}")
}

/// 阻塞记录的公开 key（C-11 起完成门不再外泄内部 id）。2.x 没有 blocker key，这是 v6 新增的格式。
pub fn blocker_key(project_code: &str, local_no: i64) -> String {
    format!("{project_code}-B-{local_no:04}")
}

pub fn review_request_key(project_code: &str, local_no: i64) -> String {
    format!("{project_code}-RR-{local_no:04}")
}

pub fn review_submission_key(project_code: &str, local_no: i64) -> String {
    format!("{project_code}-RS-{local_no:04}")
}

/// 记录 key：DECISION 是 `D`，其余种类都是 `R`，补零到 3 位。
pub fn record_key(project_code: &str, kind: RecordLetter, local_no: i64) -> String {
    format!("{project_code}-{}-{local_no:03}", kind.letter())
}

/// quick task 的 key（全局，不带项目代码）。
pub fn quick_key(local_no: i64) -> String {
    format!("Q-{local_no:04}")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecordLetter {
    /// `D`：DECISION。
    Decision,
    /// `R`：DECISION 以外的种类。
    Other,
}

impl RecordLetter {
    fn letter(self) -> char {
        match self {
            RecordLetter::Decision => 'D',
            RecordLetter::Other => 'R',
        }
    }
}

/// `{CODE}-T-<数字>` → local_no。
pub fn parse_task_key(project_code: &str, input: &str) -> Option<i64> {
    number_after(&normalize(input), &format!("{project_code}-T-"), 1)
}

pub fn parse_blocker_key(project_code: &str, input: &str) -> Option<i64> {
    number_after(&normalize(input), &format!("{project_code}-B-"), 1)
}

pub fn parse_review_request_key(project_code: &str, input: &str) -> Option<i64> {
    number_after(&normalize(input), &format!("{project_code}-RR-"), 1)
}

pub fn parse_review_submission_key(project_code: &str, input: &str) -> Option<i64> {
    number_after(&normalize(input), &format!("{project_code}-RS-"), 1)
}

/// 证据 `atm_record` 的 key（W-012）：`{CODE}-D-` 或 `{CODE}-R-` 加**至少 3 位**数字。
pub fn parse_record_key(project_code: &str, input: &str) -> Option<(RecordLetter, i64)> {
    let text = normalize(input);
    let rest = text.strip_prefix(project_code)?.strip_prefix('-')?;
    let (letter, digits) = match rest.strip_prefix("D-") {
        Some(d) => (RecordLetter::Decision, d),
        None => (RecordLetter::Other, rest.strip_prefix("R-")?),
    };
    Some((letter, digits_value(digits, 3)?))
}

fn number_after(text: &str, prefix: &str, min_digits: usize) -> Option<i64> {
    digits_value(text.strip_prefix(prefix)?, min_digits)
}

fn digits_value(digits: &str, min_digits: usize) -> Option<i64> {
    if digits.len() < min_digits || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    // 前导零任意多，先去掉再判断大小，避免 "000…0001" 溢出解析。
    let significant = digits.trim_start_matches('0');
    if significant.len() > 16 {
        return None;
    }
    let value: u64 = if significant.is_empty() {
        0
    } else {
        significant.parse().ok()?
    };
    (value <= MAX_SAFE_INTEGER).then_some(value as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn w001_task_keys_parse_with_any_padding() {
        assert_eq!(parse_task_key("ATM", "ATM-T-12"), Some(12));
        assert_eq!(parse_task_key("ATM", "ATM-T-0012"), Some(12));
        assert_eq!(
            parse_task_key("ATM", "ATM-T-0000000000000000000012"),
            Some(12)
        );
        assert_eq!(task_key("ATM", 12), "ATM-T-0012");
        assert_eq!(task_key("ATM", 12345), "ATM-T-12345");
    }

    #[test]
    fn c15_keys_are_trimmed_and_uppercased() {
        assert_eq!(parse_task_key("ATM", "  atm-t-0012\u{FEFF}"), Some(12));
        assert_eq!(parse_review_request_key("ATM", "atm-rr-1"), Some(1));
    }

    #[test]
    fn w001_malformed_or_foreign_keys_do_not_parse() {
        for bad in [
            "OTHER-T-0012",
            "ATM-T-12a",
            "ATM-T-",
            "ATM-T--1",
            "ATM-T-+1",
            "ATM-T-1 2",
            "ATM-T-１２",
            "ATMX-T-0012",
            "ATM-D-012",
            "ATM-T-9007199254740992",
        ] {
            assert_eq!(parse_task_key("ATM", bad), None, "{bad}");
        }
        assert_eq!(
            parse_task_key("ATM", "ATM-T-9007199254740991"),
            Some(9_007_199_254_740_991)
        );
    }

    #[test]
    fn w009_review_keys_keep_their_own_prefix() {
        assert_eq!(parse_review_request_key("ATM", "ATM-RR-0001"), Some(1));
        assert_eq!(parse_review_request_key("ATM", "ATM-RS-0001"), None);
        assert_eq!(parse_review_request_key("ATM", "OTH-RR-0001"), None);
        assert_eq!(parse_review_submission_key("ATM", "ATM-RS-7"), Some(7));
        assert_eq!(review_request_key("ATM", 1), "ATM-RR-0001");
        assert_eq!(review_submission_key("ATM", 1), "ATM-RS-0001");
    }

    #[test]
    fn w012_record_keys_need_three_digits() {
        assert_eq!(
            parse_record_key("ATM", "ATM-D-0398"),
            Some((RecordLetter::Decision, 398))
        );
        assert_eq!(
            parse_record_key("ATM", "atm-r-001"),
            Some((RecordLetter::Other, 1))
        );
        assert_eq!(parse_record_key("ATM", "ATM-D-98"), None);
        assert_eq!(parse_record_key("ATM", "ATM-X-398"), None);
        assert_eq!(parse_record_key("ATM", "OTH-D-398"), None);
        assert_eq!(record_key("ATM", RecordLetter::Decision, 398), "ATM-D-398");
        assert_eq!(record_key("ATM", RecordLetter::Other, 7), "ATM-R-007");
    }

    #[test]
    fn c11_blocker_keys_round_trip() {
        assert_eq!(blocker_key("ATM", 3), "ATM-B-0003");
        assert_eq!(parse_blocker_key("ATM", "atm-b-3"), Some(3));
        assert_eq!(parse_blocker_key("ATM", "ATM-T-3"), None);
        assert_eq!(quick_key(5), "Q-0005");
    }
}

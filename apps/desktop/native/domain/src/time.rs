//! 时间戳：毫秒精度的 UTC 时刻，文本形式与 JS `Date.prototype.toISOString` 相同
//! （`YYYY-MM-DDTHH:MM:SS.mmmZ`）。2.x 的租约、心跳都以这个形式存储。

use std::fmt;

/// Unix 纪元起的毫秒数。比较就是时间先后（00 C-22 的 `is_stale` 以它为准，不比字符串）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Timestamp(pub i64);

impl Timestamp {
    pub const fn from_millis(ms: i64) -> Self {
        Timestamp(ms)
    }

    pub const fn millis(self) -> i64 {
        self.0
    }

    pub const fn plus_minutes(self, minutes: i64) -> Self {
        Timestamp(self.0 + minutes * 60_000)
    }

    /// 解析 `YYYY-MM-DDTHH:MM:SS[.f…]Z`。小数秒取前三位（多出的截掉，与 `Date.parse` 一致），
    /// 不足三位右补零。其他形状（时区偏移、空格分隔、缺 `Z`）一律 None：存储里只有
    /// `toISOString` 写出来的值，宽松解析只会掩盖损坏的数据。
    pub fn parse(text: &str) -> Option<Self> {
        let b = text.as_bytes();
        if b.len() < 20 || *b.last()? != b'Z' {
            return None;
        }
        let num = |range: std::ops::Range<usize>| -> Option<i64> {
            let s = b.get(range)?;
            if s.is_empty() || !s.iter().all(u8::is_ascii_digit) {
                return None;
            }
            std::str::from_utf8(s).ok()?.parse().ok()
        };
        if b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
            return None;
        }
        let (year, month, day) = (num(0..4)?, num(5..7)?, num(8..10)?);
        let (hour, minute, second) = (num(11..13)?, num(14..16)?, num(17..19)?);
        let millis = match &b[19..b.len() - 1] {
            [] => 0,
            [b'.', frac @ ..] if !frac.is_empty() && frac.iter().all(u8::is_ascii_digit) => {
                let mut ms = 0;
                for i in 0..3 {
                    ms = ms * 10 + frac.get(i).map_or(0, |d| i64::from(d - b'0'));
                }
                ms
            }
            _ => return None,
        };
        if !(1..=12).contains(&month)
            || day < 1
            || day > days_in_month(year, month)
            || hour > 23
            || minute > 59
            || second > 59
        {
            return None;
        }
        let days = days_from_civil(year, month, day);
        Some(Timestamp(
            ((days * 24 + hour) * 60 + minute) * 60_000 + second * 1000 + millis,
        ))
    }
}

impl fmt::Display for Timestamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let days = self.0.div_euclid(86_400_000);
        let rem = self.0.rem_euclid(86_400_000);
        let (year, month, day) = civil_from_days(days);
        write!(
            f,
            "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
            rem / 3_600_000,
            rem / 60_000 % 60,
            rem / 1000 % 60,
            rem % 1000
        )
    }
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        2 if is_leap(y) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

// Howard Hinnant 的 days_from_civil / civil_from_days。
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_to_iso_string() {
        for (text, ms) in [
            ("1970-01-01T00:00:00.000Z", 0),
            ("2026-10-03T10:41:40.252Z", 1_791_024_100_252),
            ("2000-02-29T23:59:59.999Z", 951_868_799_999),
            ("1969-12-31T23:59:59.999Z", -1),
        ] {
            let t = Timestamp::parse(text).unwrap();
            assert_eq!(t.millis(), ms, "{text}");
            assert_eq!(t.to_string(), text);
        }
    }

    #[test]
    fn fraction_digits_follow_date_parse() {
        let p = |s| Timestamp::parse(s).map(Timestamp::millis);
        assert_eq!(p("1970-01-01T00:00:01Z"), Some(1000));
        assert_eq!(p("1970-01-01T00:00:00.5Z"), Some(500));
        assert_eq!(p("1970-01-01T00:00:00.1239Z"), Some(123));
    }

    #[test]
    fn malformed_text_is_refused() {
        for s in [
            "",
            "2026-10-03 10:41:40.252Z",
            "2026-10-03T10:41:40.252",
            "2026-10-03T10:41:40.252+08:00",
            "2026-02-30T00:00:00.000Z",
            "2025-02-29T00:00:00.000Z",
            "2026-13-01T00:00:00.000Z",
            "2026-10-03T24:00:00.000Z",
            "2026-10-03T10:41:40.Z",
            "2026-1a-03T10:41:40.252Z",
            "+2026-10-03T10:41:40Z",
        ] {
            assert_eq!(Timestamp::parse(s), None, "{s}");
        }
    }

    #[test]
    fn minutes_add_to_lease() {
        let t = Timestamp::parse("2026-10-03T10:31:40.252Z").unwrap();
        assert_eq!(t.plus_minutes(10).to_string(), "2026-10-03T10:41:40.252Z");
    }
}

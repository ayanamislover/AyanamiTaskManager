//! 时间：毫秒时钟、`toISOString`，以及 2.x 校验手机命令用的 `Date.parse`。
//!
//! `Date.parse` 只实现 ECMAScript 的「日期时间字符串格式」（`YYYY[-MM[-DD]][THH:mm[:ss[.s…]]][Z|±HH:mm]`，年份
//! 也可以是 `±YYYYYY`）：手机写的是 `toISOString()`，一定是这种格式。V8 对其它写法（`Tue Oct 10 2026` 之类）
//! 的启发式解析不跟，这些一律当作无法识别——结果是 `COMMAND_INVALID`（2.x 可能接受后再按时间判断）。
//! 只有日期是 UTC；有时间、没写时区的按本地时间（与 ECMAScript 一致）。

use std::time::{SystemTime, UNIX_EPOCH};

use atm_domain::time::Timestamp;

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// `new Date(ms).toISOString()`。
pub fn iso(ms: i64) -> String {
    Timestamp::from_millis(ms).to_string()
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        _ => 28,
    }
}

/// 本地时间（不带时区的日期时间）→ UTC 毫秒。
#[cfg(windows)]
fn local_to_utc(y: i64, mo: i64, d: i64, h: i64, mi: i64, s: i64, ms: i64) -> Option<i64> {
    use windows_sys::Win32::Foundation::SYSTEMTIME;
    use windows_sys::Win32::System::Time::TzSpecificLocalTimeToSystemTime;
    if !(1601..=30827).contains(&y) {
        // 系统接口的年份范围之外：按当前的偏移近似（远古或远未来的命令反正会因时间不合理被拒）。
        let probe = local_to_utc(2000, 1, 1, 0, 0, 0, 0)?;
        let offset = probe - days_from_civil(2000, 1, 1) * 86_400_000;
        return Some(
            ((days_from_civil(y, mo, d) * 24 + h) * 60 + mi) * 60_000 + s * 1000 + ms + offset,
        );
    }
    let local = SYSTEMTIME {
        wYear: y as u16,
        wMonth: mo as u16,
        wDayOfWeek: 0,
        wDay: d as u16,
        wHour: h as u16,
        wMinute: mi as u16,
        wSecond: s as u16,
        wMilliseconds: ms as u16,
    };
    let mut utc = SYSTEMTIME { ..local };
    // SAFETY: 两个结构体都有效；时区用当前的（空指针）。
    if unsafe { TzSpecificLocalTimeToSystemTime(std::ptr::null(), &local, &mut utc) } == 0 {
        return None;
    }
    Some(
        ((days_from_civil(
            i64::from(utc.wYear),
            i64::from(utc.wMonth),
            i64::from(utc.wDay),
        ) * 24
            + i64::from(utc.wHour))
            * 60
            + i64::from(utc.wMinute))
            * 60_000
            + i64::from(utc.wSecond) * 1000
            + i64::from(utc.wMilliseconds),
    )
}

#[cfg(not(windows))]
fn local_to_utc(y: i64, mo: i64, d: i64, h: i64, mi: i64, s: i64, ms: i64) -> Option<i64> {
    Some(((days_from_civil(y, mo, d) * 24 + h) * 60 + mi) * 60_000 + s * 1000 + ms)
}

/// 8.64e15：`Date` 能表示的最大毫秒数。
const MAX_TIME: i64 = 8_640_000_000_000_000;

/// `Date.parse` 的 ECMAScript 日期时间格式部分；认不出是 `None`（JS 的 NaN）。
pub fn js_date_parse(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    let mut i = 0;
    let digits = |i: &mut usize, n: usize| -> Option<i64> {
        let s = b.get(*i..*i + n)?;
        if !s.iter().all(u8::is_ascii_digit) {
            return None;
        }
        *i += n;
        std::str::from_utf8(s).ok()?.parse().ok()
    };
    let year = match b.first()? {
        b'+' | b'-' => {
            let neg = b[0] == b'-';
            i = 1;
            let y = digits(&mut i, 6)?;
            if neg && y == 0 {
                return None; // `-000000` 不合法
            }
            if neg { -y } else { y }
        }
        _ => digits(&mut i, 4)?,
    };
    let (mut month, mut day) = (1, 1);
    if b.get(i) == Some(&b'-') {
        i += 1;
        month = digits(&mut i, 2)?;
        if b.get(i) == Some(&b'-') {
            i += 1;
            day = digits(&mut i, 2)?;
        }
    }
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    let (mut hour, mut minute, mut second, mut millis) = (0, 0, 0, 0);
    let mut has_time = false;
    if b.get(i) == Some(&b'T') {
        has_time = true;
        i += 1;
        hour = digits(&mut i, 2)?;
        if b.get(i) != Some(&b':') {
            return None;
        }
        i += 1;
        minute = digits(&mut i, 2)?;
        if b.get(i) == Some(&b':') {
            i += 1;
            second = digits(&mut i, 2)?;
            if b.get(i) == Some(&b'.') {
                i += 1;
                let start = i;
                while b.get(i).is_some_and(u8::is_ascii_digit) {
                    i += 1;
                }
                if i == start {
                    return None;
                }
                // 小数秒取前三位，多出的截掉，不足三位右补零。
                let frac = &b[start..i];
                for k in 0..3 {
                    millis = millis * 10 + frac.get(k).map_or(0, |d| i64::from(d - b'0'));
                }
            }
        }
        let midnight = hour == 24 && minute == 0 && second == 0 && millis == 0;
        if (hour > 23 && !midnight) || minute > 59 || second > 59 {
            return None;
        }
    }
    let offset_minutes = match b.get(i) {
        None => None,
        Some(b'Z') if has_time => {
            i += 1;
            Some(0)
        }
        Some(sign @ (b'+' | b'-')) if has_time => {
            let neg = *sign == b'-';
            i += 1;
            let oh = digits(&mut i, 2)?;
            if b.get(i) != Some(&b':') {
                return None;
            }
            i += 1;
            let om = digits(&mut i, 2)?;
            if oh > 23 || om > 59 {
                return None;
            }
            let total = oh * 60 + om;
            Some(if neg { -total } else { total })
        }
        _ => return None,
    };
    if i != b.len() {
        return None;
    }
    let utc = match offset_minutes {
        Some(off) => {
            ((days_from_civil(year, month, day) * 24 + hour) * 60 + minute - off) * 60_000
                + second * 1000
                + millis
        }
        None if !has_time => ((days_from_civil(year, month, day) * 24) * 60) * 60_000,
        None => {
            // 24:00 是第二天的 0 点。
            let (y, mo, d, h) = if hour == 24 {
                let next = days_from_civil(year, month, day) + 1;
                let (ny, nm, nd) = civil_from_days(next);
                (ny, nm, nd, 0)
            } else {
                (year, month, day, hour)
            };
            local_to_utc(y, mo, d, h, minute, second, millis)?
        }
    };
    (utc.abs() <= MAX_TIME).then_some(utc)
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_strings_parse_like_date_parse() {
        let base = js_date_parse("2026-10-10T13:50:34.123Z").unwrap();
        assert_eq!(iso(base), "2026-10-10T13:50:34.123Z");
        assert_eq!(js_date_parse("2026-10-10T13:50:34.1234567Z"), Some(base));
        assert_eq!(js_date_parse("2026-10-10T13:50:34.1Z"), Some(base - 23));
        assert_eq!(js_date_parse("2026-10-10T21:50:34.123+08:00"), Some(base));
        assert_eq!(js_date_parse("2026-10-10T13:50Z"), Some(base - 34_123));
        assert_eq!(
            js_date_parse("2026-10-10"),
            js_date_parse("2026-10-10T00:00:00.000Z")
        );
        assert_eq!(
            js_date_parse("2026-10"),
            js_date_parse("2026-10-01T00:00:00Z")
        );
        assert_eq!(js_date_parse("+002026-10-10T13:50:34.123Z"), Some(base));
        assert_eq!(
            js_date_parse("2026-10-10T24:00:00Z"),
            js_date_parse("2026-10-11T00:00:00Z")
        );
        for bad in [
            "",
            "2026-13-01",
            "2026-02-30",
            "2026-10-10T25:00Z",
            "2026-10-10 13:50:34Z",
            "2026-10-10Z",
            "Tue Oct 10 2026",
            "2026-10-10T13:50:34.Z",
            "-000000-01-01",
            "2026-10-10T13:50:34+0800",
            "2026-10-10T13:50:34.123Zjunk",
        ] {
            assert_eq!(js_date_parse(bad), None, "{bad}");
        }
        // 没写时区的日期时间按本地时间：与带上当前偏移的写法一致。
        assert!(js_date_parse("2026-10-10T13:50:34.123").is_some());
    }
}

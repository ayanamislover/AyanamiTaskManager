//! MCP 桥进程观测（2.0 `mcp-bridge-observation.ts`）：数 Agent 客户端直接拉起的那些桥各占多少私有内存。
//!
//! 2.0 起 PowerShell 与 typeperf 采样；3.0 用一次 Toolhelp32 快照拿进程树，再逐个读映像路径、创建时刻和
//! `PrivateUsage`（只数私有页，共享页不加和）。判据：映像与某个桥命令是同一个文件，并且直接父进程是 `codex` 或
//! `claude`；采样之间退出的、父进程认不出的一律不计。2.x 的宿主入口（`AyanamiTaskManager.exe --mcp-stdio`）后面
//! 挂着 `atm-core`，那一串按固定两层汇总，到 `atm-core` 为止。
//!
//! 「同一个文件」：路径按字面规范化后相同（[`key`]），或者文件名相同、文件身份（卷号 + 文件号，打开时跟进链接）
//! 也相同。后一条是为了 `L\current` 这个目录链接（W8 关口 peer r14 P2-02）：桥命令写的是
//! `L\current\resources\atm-mcp.exe`，进程映像却是链接指向的物理目录里的那个文件。身份在每次观测时现查，
//! 链接换到新版本后，下一次观测就跟着新目标走；从旧版本目录起的桥（客户端还没重启）不再算。

use serde_json::{Value, json};

/// 快照里的一个进程。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Proc {
    pub pid: u32,
    pub parent: u32,
    /// 映像名（不带 `.exe`）。
    pub name: String,
    pub path: Option<String>,
    pub started_ms: Option<i64>,
    pub private_bytes: Option<u64>,
}

const HOST_CHAIN: [&str; 2] = ["ayanamitaskmanager", "atm-core"];

fn stem(name: &str) -> String {
    let lower = name.trim().to_ascii_lowercase();
    lower
        .strip_suffix(".exe")
        .map(str::to_string)
        .unwrap_or(lower)
}

fn supported_owner(name: &str) -> bool {
    matches!(stem(name).as_str(), "codex" | "claude")
}

/// 路径的根占几段（按 `\` 与 `/` 切开之后）：盘符 `C:` 一段；UNC `\\server\share` 四段（两个空段、服务器、
/// 共享）；以 `\` 开头的一段（那个空段）；相对路径没有根。`\\?\` 与 `\\.\` 开头的设备路径先由 [`key`] 换成普通写法。
fn root_len(parts: &[&str]) -> usize {
    match parts {
        ["", "", server, share, ..] if !server.is_empty() && !share.is_empty() => 4,
        [drive, ..] if drive.len() == 2 && drive.ends_with(':') => 1,
        ["", ..] => 1,
        _ => 0,
    }
}

/// 比较用的路径键：分隔符统一成 `\`，去掉 `.` 与多余的分隔符，按字面消掉 `..`，不分大小写。进程的映像
/// 路径（`QueryFullProcessImageNameW`）总是规范的，桥命令不一定：它由数据根拼出来，数据根里带 `..` 或 `/`
/// 时同一个文件也会对不上（W8 关口在 CI 上：`target` 是 `agents\..\target`）。
///
/// 根不受 `..` 影响（W8 关口 peer r14 P2-01）：绝对路径根处的 `..` 照 Windows 的做法丢掉（`C:\..\a` 就是
/// `C:\a`），UNC 的服务器与共享名不会被 `..` 弹出、跨到别的共享去。`\\?\C:\…` 与 `\\?\UNC\server\share\…`
/// 换成普通写法再比较。不解析链接与短名：那些由文件身份比较（见模块说明）。
///
/// 盘符相对路径（`C:a`、`C:`）相对于那个盘的当前目录，不是 `C:\a`（W8 关口 peer r15 P2-02）：键写成 `c:`
/// 紧跟相对部分的键，与 `c:\…` 区分开。
///
/// 名字结尾的 `.` 与空格照 Win32 的做法去掉（[`win32_segment`]，W8 关口 peer r16 P2-02）：`atm-mcp.exe.` 打开的
/// 就是 `atm-mcp.exe`。`\\?\` 开头的路径按字面：不消 `.`、`..`，不去结尾，`/` 也不是分隔符。
fn key(path: &str) -> String {
    if let Some(rest) = drive_relative(path) {
        let rest = if rest.is_empty() {
            String::new()
        } else {
            key(rest)
        };
        return format!("{}{rest}", &path[..2]).to_lowercase();
    }
    let verbatim = path.starts_with(r"\\?\");
    let mut parts: Vec<&str> = if verbatim {
        path.split('\\').collect()
    } else {
        path.split(['\\', '/']).collect()
    };
    if let ["", "", "?" | ".", rest @ ..] = parts.as_slice() {
        parts = match rest {
            [unc, server, share, tail @ ..] if unc.eq_ignore_ascii_case("unc") => {
                [&["", "", *server, *share][..], tail].concat()
            }
            [drive, tail @ ..] if drive.len() == 2 && drive.ends_with(':') => {
                [&[*drive][..], tail].concat()
            }
            _ => parts,
        };
    }
    let root = root_len(&parts);
    let last = parts.len() - 1;
    let ends_in_separator = path.ends_with(['\\', '/']);
    let mut out: Vec<&str> = parts[..root].to_vec();
    for (i, part) in parts.iter().enumerate().skip(root) {
        if verbatim {
            if !part.is_empty() {
                out.push(part);
            }
            continue;
        }
        match win32_segment(part, i == last && !ends_in_separator) {
            "" | "." => {}
            ".." if out.len() > root && out.last() != Some(&"..") => {
                out.pop();
            }
            // 绝对路径到了根就停在根上；相对路径留着它。
            ".." if root > 0 => {}
            p => out.push(p),
        }
    }
    let joined = out.join("\\");
    // 只有根的绝对路径（`C:`、`\`）补上分隔符，与 `C:\`、`\` 写法一致。
    let joined = if out.len() == root && root == 1 && !joined.ends_with('\\') {
        format!("{joined}\\")
    } else {
        joined
    };
    joined.to_lowercase()
}

/// Win32 路径（不是 `\\?\`）里一段名字照 Windows 规范化之后的样子（.NET「File path formats」的
/// 规则）：一段以单个 `.` 结尾就去掉那个 `.`；最后一段（路径不以分隔符结尾时）去掉结尾所有的 `.` 与空格。
/// `.`、`..` 本身不动；去完什么都不剩的照原样留着。
fn win32_segment(part: &str, last: bool) -> &str {
    if part == "." || part == ".." {
        return part;
    }
    let trimmed = if last {
        part.trim_end_matches(['.', ' '])
    } else {
        match part.strip_suffix('.') {
            Some(rest) if !rest.ends_with('.') => rest,
            _ => part,
        }
    };
    if trimmed.is_empty() { part } else { trimmed }
}

/// 盘符相对路径（盘符与冒号后面不是分隔符）去掉盘符之后的部分；别的路径是 `None`。
fn drive_relative(path: &str) -> Option<&str> {
    let b = path.as_bytes();
    (b.len() >= 2
        && b[0].is_ascii_alphabetic()
        && b[1] == b':'
        && !matches!(b.get(2), Some(b'\\' | b'/')))
    .then(|| &path[2..])
}

/// 键的最后一段：文件名。盘符相对路径的盘符不算在文件名里。
fn file_name(key: &str) -> &str {
    let key = drive_relative(key).unwrap_or(key);
    key.rsplit('\\').next().unwrap_or(key)
}

/// 文件身份：卷序列号与文件号。
pub type FileId = (u32, u64);

/// 按路径打开（跟进链接）、读文件身份。打不开就是 `None`。只读属性，不读内容，什么都不改。
#[cfg(windows)]
pub fn file_id(path: &str) -> Option<FileId> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, GetFileInformationByHandle,
    };
    let f = std::fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .ok()?;
    // SAFETY: 全零是合法的初值；句柄在 `f` 活着时有效。
    let mut i: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(f.as_raw_handle(), &mut i) } == 0 {
        return None;
    }
    Some((
        i.dwVolumeSerialNumber,
        ((i.nFileIndexHigh as u64) << 32) | i.nFileIndexLow as u64,
    ))
}

#[cfg(not(windows))]
pub fn file_id(_path: &str) -> Option<FileId> {
    None
}

/// 一个桥命令：路径键，与它现在指向的文件的身份（查不到就只按路径比）。
struct Wanted {
    key: String,
    id: Option<FileId>,
}

fn chain_private_bytes(root: u32, procs: &[Proc]) -> u64 {
    let mut total = 0;
    let mut parents = vec![root];
    for depth in 0..HOST_CHAIN.len() {
        if parents.is_empty() {
            break;
        }
        let allowed = &HOST_CHAIN[depth..];
        let level: Vec<&Proc> = procs
            .iter()
            .filter(|p| allowed.contains(&stem(&p.name).as_str()) && parents.contains(&p.parent))
            .collect();
        total += level
            .iter()
            .map(|p| p.private_bytes.unwrap_or(0))
            .sum::<u64>();
        parents = level
            .iter()
            .filter(|p| stem(&p.name) != HOST_CHAIN[HOST_CHAIN.len() - 1])
            .map(|p| p.pid)
            .collect();
    }
    total
}

fn iso(ms: i64) -> String {
    atm_domain::time::Timestamp::from_millis(ms).to_string()
}

/// 从一份快照算出 2.0 `McpBridgeObservation` 的形状。同一路径只算一次。`id_of` 读文件身份（[`file_id`]；
/// 用例给假的）：只对与某个桥命令同名、路径却不同的映像才查。
pub fn observe_from(
    procs: &[Proc],
    commands: &[String],
    now_ms: i64,
    id_of: &dyn Fn(&str) -> Option<FileId>,
) -> Value {
    let mut wanted: Vec<Wanted> = Vec::new();
    for c in commands {
        let k = key(c);
        if !wanted.iter().any(|w| w.key == k) {
            wanted.push(Wanted {
                id: id_of(c),
                key: k,
            });
        }
    }
    let is_bridge = |path: &str| {
        let k = key(path);
        let same_name: Vec<&Wanted> = wanted
            .iter()
            .filter(|w| file_name(&w.key) == file_name(&k))
            .collect();
        if same_name.iter().any(|w| w.key == k) {
            return true;
        }
        if !same_name.iter().any(|w| w.id.is_some()) {
            return false;
        }
        let id = id_of(path);
        id.is_some() && same_name.iter().any(|w| w.id == id)
    };
    let mut bridges = Vec::new();
    let mut total: u64 = 0;
    for p in procs {
        let Some(path) = &p.path else { continue };
        if !is_bridge(path) {
            continue;
        }
        let (Some(started), Some(private)) = (p.started_ms, p.private_bytes) else {
            continue;
        };
        let Some(owner) = procs.iter().find(|o| o.pid == p.parent && p.parent != 0) else {
            continue;
        };
        if !supported_owner(&owner.name) {
            continue;
        }
        let host = stem(&p.name) == HOST_CHAIN[0];
        let bytes = private
            + if host {
                chain_private_bytes(p.pid, procs)
            } else {
                0
            };
        total += bytes;
        bridges.push(json!({
            "pid": p.pid,
            "ownerPid": owner.pid,
            "ownerName": owner.name,
            "startedAt": iso(started),
            "privateBytes": bytes,
        }));
    }
    json!({
        "sampledAt": iso(now_ms),
        "metric": "PRIVATE_BYTES",
        "totalPrivateBytes": total,
        "bridges": bridges,
    })
}

/// 本机的进程快照。只读：不结束、不注入任何进程，打不开的（别的用户、受保护进程）只留名字与父进程。
#[cfg(windows)]
pub fn snapshot() -> Vec<Proc> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        QueryFullProcessImageNameW,
    };

    let mut out = Vec::new();
    // SAFETY: 句柄在本函数内创建并关闭；结构体按文档先置 dwSize / cb。
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE || snap.is_null() {
            return out;
        }
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = Process32FirstW(snap, &mut e) != 0;
        while ok {
            let len = e
                .szExeFile
                .iter()
                .position(|c| *c == 0)
                .unwrap_or(e.szExeFile.len());
            let exe = String::from_utf16_lossy(&e.szExeFile[..len]);
            let name = exe
                .strip_suffix(".exe")
                .or_else(|| exe.strip_suffix(".EXE"))
                .unwrap_or(&exe)
                .to_string();
            out.push(Proc {
                pid: e.th32ProcessID,
                parent: e.th32ParentProcessID,
                name,
                ..Proc::default()
            });
            ok = Process32NextW(snap, &mut e) != 0;
        }
        CloseHandle(snap);
        for p in &mut out {
            if p.pid == 0 {
                continue;
            }
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, p.pid);
            if h.is_null() {
                continue;
            }
            let mut buf = vec![0u16; 32768];
            let mut size = buf.len() as u32;
            if QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut size) != 0 {
                p.path = Some(String::from_utf16_lossy(&buf[..size as usize]));
            }
            let mut created: FILETIME = std::mem::zeroed();
            let mut exit: FILETIME = std::mem::zeroed();
            let mut kernel: FILETIME = std::mem::zeroed();
            let mut user: FILETIME = std::mem::zeroed();
            if GetProcessTimes(h, &mut created, &mut exit, &mut kernel, &mut user) != 0 {
                let ticks = ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64;
                // FILETIME 是 1601 起的 100ns；减去到 1970 的 11644473600 秒。
                p.started_ms = Some((ticks / 10_000) as i64 - 11_644_473_600_000);
            }
            let mut mem: PROCESS_MEMORY_COUNTERS_EX = std::mem::zeroed();
            mem.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
            if GetProcessMemoryInfo(
                h,
                &mut mem as *mut _ as *mut PROCESS_MEMORY_COUNTERS,
                mem.cb,
            ) != 0
            {
                p.private_bytes = Some(mem.PrivateUsage as u64);
            }
            CloseHandle(h);
        }
    }
    out
}

#[cfg(not(windows))]
pub fn snapshot() -> Vec<Proc> {
    Vec::new()
}

/// 观测这些桥命令（3.0 的 shim，以及仍握着旧配置的 2.x 宿主入口）。
pub fn observe(commands: &[String]) -> Value {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64);
    observe_from(&snapshot(), commands, now, &file_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(pid: u32, parent: u32, name: &str, path: Option<&str>, bytes: u64) -> Proc {
        Proc {
            pid,
            parent,
            name: name.into(),
            path: path.map(str::to_string),
            started_ms: Some(0),
            private_bytes: Some(bytes),
        }
    }

    /// 查不到文件身份：只按路径比。
    fn no_id(_: &str) -> Option<FileId> {
        None
    }

    #[test]
    fn only_direct_children_of_codex_or_claude_count() {
        let shim = r"C:\L\current\resources\atm-mcp.exe";
        let procs = vec![
            p(10, 1, "codex", None, 1),
            p(11, 1, "explorer", None, 1),
            p(20, 10, "atm-mcp", Some(shim), 100),
            p(21, 11, "atm-mcp", Some(shim), 200),
            p(22, 99, "atm-mcp", Some(shim), 300),
            p(23, 10, "atm-mcp", Some(r"C:\other\atm-mcp.exe"), 400),
        ];
        let v = observe_from(&procs, &[shim.to_uppercase()], 0, &no_id);
        assert_eq!(v["totalPrivateBytes"], 100);
        assert_eq!(v["bridges"].as_array().unwrap().len(), 1);
        assert_eq!(v["bridges"][0]["ownerName"], "codex");
        assert_eq!(v["metric"], "PRIVATE_BYTES");
    }

    /// W8 关口在 CI 上：桥命令由数据根拼出来，不一定是规范的路径；进程的映像路径总是规范的。
    #[test]
    fn a_bridge_command_written_another_way_is_the_same_path() {
        let image = r"C:\L\current\resources\atm-mcp.exe";
        let procs = vec![
            p(10, 1, "codex", None, 1),
            p(20, 10, "atm-mcp", Some(image), 100),
        ];
        for command in [
            r"C:\x\..\L\current\resources\atm-mcp.exe",
            r"C:\L\.\current\resources\\atm-mcp.exe",
            "C:/L/current/resources/atm-mcp.exe",
            r"c:\l\CURRENT\x\y\..\..\resources\atm-mcp.exe",
        ] {
            let v = observe_from(&procs, &[command.to_string()], 0, &no_id);
            assert_eq!(v["totalPrivateBytes"], 100, "{command}");
        }
        // Both sides go through the same key: an image path written another way matches too.
        let other_image = vec![
            p(10, 1, "codex", None, 1),
            p(
                20,
                10,
                "atm-mcp",
                Some("C:/L/x/../current/resources/ATM-MCP.exe"),
                100,
            ),
        ];
        let v = observe_from(&other_image, &[image.to_string()], 0, &no_id);
        assert_eq!(v["totalPrivateBytes"], 100);
        // Another file is still another file, however it is written.
        for command in [
            r"C:\L\current\resources\..\atm-mcp.exe",
            r"C:\L\current\atm-mcp.exe\..\resources\x.exe",
            r"\\server\L\current\resources\atm-mcp.exe",
        ] {
            let v = observe_from(&procs, &[command.to_string()], 0, &no_id);
            assert_eq!(v["totalPrivateBytes"], 0, "{command}");
        }
        assert_eq!(key(r"\\server\share\.\a\..\b"), r"\\server\share\b");
    }

    /// W8 关口 peer r14 P2-01：根不受 `..` 影响。绝对路径根处的 `..` 照 Windows 的做法丢掉；UNC 的服务器与共享名
    /// 不会被弹出、跨到别的共享去；设备路径写法与普通写法是同一个。
    #[test]
    fn the_root_of_a_path_is_never_crossed() {
        for (path, want) in [
            (r"\\server\share\..\other\x", r"\\server\share\other\x"),
            (r"\\server\share\..\..\x", r"\\server\share\x"),
            (r"C:\..\a", r"c:\a"),
            (r"C:\a\..\..\b", r"c:\b"),
            (r"C:\..", r"c:\"),
            (r"\a\..\..\b", r"\b"),
            (r"\\?\C:\L\x", r"c:\l\x"),
            (r"\\?\UNC\Server\Share\x", r"\\server\share\x"),
            (r"\\.\C:\x\..\y", r"c:\y"),
            // 相对路径没有根，开头的 `..` 留着。
            (r"..\a", r"..\a"),
            (r"a\..\..\b", r"..\b"),
        ] {
            assert_eq!(key(path), want, "{path}");
        }
        assert_ne!(key(r"\\server\share\..\other\x"), key(r"\\server\other\x"));
        let procs = |image: &str| {
            vec![
                p(10, 1, "codex", None, 1),
                p(20, 10, "atm-mcp", Some(image), 100),
            ]
        };
        let command = [r"\\server\share\..\other\atm-mcp.exe".to_string()];
        let v = observe_from(&procs(r"\\server\other\atm-mcp.exe"), &command, 0, &no_id);
        assert_eq!(v["totalPrivateBytes"], 0, "another share is another file");
        let v = observe_from(
            &procs(r"\\server\share\other\atm-mcp.exe"),
            &command,
            0,
            &no_id,
        );
        assert_eq!(v["totalPrivateBytes"], 100);
    }

    /// W8 关口 peer r15 P2-02：盘符相对路径（`C:a`）相对于那个盘的当前目录，与 `C:\a` 不是同一个键；文件名照样是
    /// 最后一段。于是普通相对、盘符相对、盘符绝对三种写法的命令，身份与映像相同就算，不同就不算。
    #[test]
    fn a_drive_relative_command_is_relative_to_that_drive() {
        for (path, want) in [
            ("C:atm-mcp.exe", "c:atm-mcp.exe"),
            (r"C:a\..\atm-mcp.exe", "c:atm-mcp.exe"),
            (r"C:..\x", r"c:..\x"),
            ("C:", "c:"),
            (r"C:a\..", "c:"),
            (r"C:\a", r"c:\a"),
        ] {
            assert_eq!(key(path), want, "{path}");
        }
        assert_ne!(key("C:atm-mcp.exe"), key(r"C:\atm-mcp.exe"));
        assert_ne!(key("C:atm-mcp.exe"), key("atm-mcp.exe"));
        for path in [
            "C:atm-mcp.exe",
            r"C:sub\atm-mcp.exe",
            "atm-mcp.exe",
            r"C:\x\atm-mcp.exe",
        ] {
            assert_eq!(file_name(&key(path)), "atm-mcp.exe", "{path}");
        }
        let image = r"C:\synthetic\atm-mcp.exe";
        let procs = vec![
            p(10, 1, "codex", None, 1),
            p(20, 10, "atm-mcp", Some(image), 100),
        ];
        for command in [
            "C:atm-mcp.exe",
            r"C:sub\atm-mcp.exe",
            "atm-mcp.exe",
            r"C:\elsewhere\atm-mcp.exe",
        ] {
            let same = |path: &str| {
                let k = key(path);
                Some((7, u64::from(k != key(image) && k != key(command))))
            };
            let v = observe_from(&procs, &[command.to_string()], 0, &same);
            assert_eq!(v["totalPrivateBytes"], 100, "same file: {command}");
            let other = |path: &str| Some((7, u64::from(key(path) != key(image))));
            let v = observe_from(&procs, &[command.to_string()], 0, &other);
            assert_eq!(v["totalPrivateBytes"], 0, "another file: {command}");
        }
        // 名字不同的，身份相同也不算（同名才查身份）。
        let same = |_: &str| Some((7, 0));
        let v = observe_from(&procs, &["C:renamed.exe".to_string()], 0, &same);
        assert_eq!(v["totalPrivateBytes"], 0);
    }

    /// W8 关口 peer r16 P2-02：Win32 路径名字结尾的 `.` 与空格由 Windows 去掉，`atm-mcp.exe.` 打开的就是
    /// `atm-mcp.exe`；`\\?\` 路径按字面，结尾的 `.` 是名字的一部分，不消 `.`、`..`。
    #[test]
    fn a_name_ending_in_dots_or_spaces_is_the_name_without_them() {
        for (path, want) in [
            (r"C:\x\atm-mcp.exe.", r"c:\x\atm-mcp.exe"),
            (r"C:\x\atm-mcp.exe. . ", r"c:\x\atm-mcp.exe"),
            (r"C:\x.\atm-mcp.exe", r"c:\x\atm-mcp.exe"),
            (r"C:\x..\atm-mcp.exe", r"c:\x..\atm-mcp.exe"),
            (r"C:\x \atm-mcp.exe", r"c:\x \atm-mcp.exe"),
            (r"C:\x\a.\", r"c:\x\a"),
            (r"C:\x\...", r"c:\x\..."),
            ("atm-mcp.exe.", "atm-mcp.exe"),
            ("C:atm-mcp.exe.", "c:atm-mcp.exe"),
            (r"\\.\C:\x\atm-mcp.exe.", r"c:\x\atm-mcp.exe"),
            // `\\?\` 按字面。
            (r"\\?\C:\x\atm-mcp.exe.", r"c:\x\atm-mcp.exe."),
            (r"\\?\C:\x\..\y", r"c:\x\..\y"),
            (r"\\?\C:\x\.\y", r"c:\x\.\y"),
            (r"\\?\C:\x/y", r"c:\x/y"),
        ] {
            assert_eq!(key(path), want, "{path}");
        }
        let image = r"C:\synthetic\atm-mcp.exe";
        let procs = vec![
            p(10, 1, "codex", None, 1),
            p(20, 10, "atm-mcp", Some(image), 100),
        ];
        for command in [r"C:\synthetic\atm-mcp.exe.", r"C:\synthetic\atm-mcp.exe  "] {
            let v = observe_from(&procs, &[command.to_string()], 0, &no_id);
            assert_eq!(v["totalPrivateBytes"], 100, "same file: {command}");
        }
        for command in [
            r"\\?\C:\synthetic\atm-mcp.exe.",
            r"C:\synthetic\atm-mcp.ex.",
            r"C:\synthetic.x\atm-mcp.exe",
        ] {
            let v = observe_from(&procs, &[command.to_string()], 0, &no_id);
            assert_eq!(v["totalPrivateBytes"], 0, "another file: {command}");
        }
    }

    /// W8 关口 peer r14 P2-02：桥命令写的是 `L\current\…`（目录链接），进程映像是链接指向的物理目录里的文件。
    /// 同名、文件身份相同就是同一个；从旧版本目录起的、只是身份碰巧相同但名字不同的，都不算。
    #[test]
    fn a_command_through_a_directory_link_is_the_file_it_points_to() {
        let command = [r"C:\L\current\resources\atm-mcp.exe".to_string()];
        let ids = |path: &str| match key(path).as_str() {
            r"c:\l\current\resources\atm-mcp.exe" | r"c:\l\app-3.0.1\resources\atm-mcp.exe" => {
                Some((7, 1))
            }
            r"c:\l\app-3.0.0\resources\atm-mcp.exe" => Some((7, 2)),
            r"c:\elsewhere\renamed.exe" => Some((7, 1)),
            _ => None,
        };
        let procs = vec![
            p(10, 1, "codex", None, 1),
            p(
                20,
                10,
                "atm-mcp",
                Some(r"C:\L\app-3.0.1\resources\atm-mcp.exe"),
                100,
            ),
            p(
                21,
                10,
                "atm-mcp",
                Some(r"C:\L\app-3.0.0\resources\atm-mcp.exe"),
                200,
            ),
            p(22, 10, "renamed", Some(r"C:\elsewhere\renamed.exe"), 400),
        ];
        let v = observe_from(&procs, &command, 0, &ids);
        assert_eq!(v["totalPrivateBytes"], 100, "{v}");
        assert_eq!(v["bridges"][0]["pid"], 20, "{v}");
        // 查不到身份（链接不在）时只按路径比：物理目录里的不算。
        let v = observe_from(&procs, &command, 0, &no_id);
        assert_eq!(v["totalPrivateBytes"], 0, "{v}");
    }

    #[test]
    fn a_2x_host_entry_sums_its_fixed_chain() {
        let host = r"C:\L\current\AyanamiTaskManager.exe";
        let procs = vec![
            p(10, 1, "claude", None, 1),
            p(20, 10, "AyanamiTaskManager", Some(host), 10),
            p(
                30,
                20,
                "AyanamiTaskManager",
                Some(r"C:\L\app-2\AyanamiTaskManager.exe"),
                20,
            ),
            p(40, 30, "atm-core", None, 40),
            // atm-core 下面被唤醒的桌面不算。
            p(50, 40, "AyanamiTaskManager", None, 1000),
        ];
        let v = observe_from(&procs, &[host.into()], 0, &no_id);
        assert_eq!(v["totalPrivateBytes"], 70);
    }
}

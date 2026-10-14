//! MCP 桥进程观测（2.0 `mcp-bridge-observation.ts`）：数 Agent 客户端直接拉起的那些桥各占多少私有内存。
//!
//! 2.0 起 PowerShell 与 typeperf 采样；3.0 用一次 Toolhelp32 快照拿进程树，再逐个读映像路径、创建时刻和
//! `PrivateUsage`（只数私有页，共享页不加和）。判据照旧：映像路径与某个桥命令是同一个路径（不分大小写，
//! 按字面规范化，见 `key`），并且直接父进程是 `codex` 或 `claude`；采样之间退出的、父进程认不出的一律不计。2.x 的宿主入口
//! （`AyanamiTaskManager.exe --mcp-stdio`）后面挂着 `atm-core`，那一串按固定两层汇总，到 `atm-core` 为止。

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

/// 比较用的路径键：分隔符统一成 `\`，去掉 `.` 与多余的分隔符，按字面消掉 `..`，不分大小写。进程的映像
/// 路径（`QueryFullProcessImageNameW`）总是规范的，桥命令不一定：它由数据根拼出来，数据根里带 `..` 或 `/`
/// 时同一个文件也会对不上（W8 关口在 CI 上：`target` 是 `agents\..\target`）。不解析链接与短名。
fn key(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split(['\\', '/']) {
        match part {
            // 开头的空段是 UNC 的 `\\`，留着；中间的是多余的分隔符。
            "" if parts.iter().all(|p| p.is_empty()) => parts.push(part),
            "" | "." => {}
            ".." if parts
                .last()
                .is_some_and(|p| !p.is_empty() && *p != ".." && !p.ends_with(':')) =>
            {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    parts.join("\\").to_lowercase()
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

/// 从一份快照算出 2.0 `McpBridgeObservation` 的形状。同一路径只算一次。
pub fn observe_from(procs: &[Proc], commands: &[String], now_ms: i64) -> Value {
    let mut wanted: Vec<String> = Vec::new();
    for c in commands {
        let k = key(c);
        if !wanted.contains(&k) {
            wanted.push(k);
        }
    }
    let mut bridges = Vec::new();
    let mut total: u64 = 0;
    for p in procs {
        let Some(path) = &p.path else { continue };
        if !wanted.contains(&key(path)) {
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
    observe_from(&snapshot(), commands, now)
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
        let v = observe_from(&procs, &[shim.to_uppercase()], 0);
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
            let v = observe_from(&procs, &[command.to_string()], 0);
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
        let v = observe_from(&other_image, &[image.to_string()], 0);
        assert_eq!(v["totalPrivateBytes"], 100);
        // Another file is still another file, however it is written.
        for command in [
            r"C:\L\current\resources\..\atm-mcp.exe",
            r"C:\L\current\atm-mcp.exe\..\resources\x.exe",
            r"\\server\L\current\resources\atm-mcp.exe",
        ] {
            let v = observe_from(&procs, &[command.to_string()], 0);
            assert_eq!(v["totalPrivateBytes"], 0, "{command}");
        }
        assert_eq!(key(r"\\server\share\.\a\..\b"), r"\\server\share\b");
        assert_eq!(key(r"C:\..\a"), r"c:\..\a");
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
        let v = observe_from(&procs, &[host.into()], 0);
        assert_eq!(v["totalPrivateBytes"], 70);
    }
}

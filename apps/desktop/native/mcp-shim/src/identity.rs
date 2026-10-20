//! The client identity sent as `X-ATM-Client` (10 R11 A4): `<pid>:<creation time>@<name>`.
//!
//! `<pid>` is the first ancestor of this bridge that is not a shell wrapper (cmd,
//! PowerShell, a POSIX shell): the Agent process that spawned the bridge, directly or
//! through `cmd /c`. All three profile bridges of one Agent instance therefore share the
//! value, and two instances never do. `<creation time>` (FILETIME ticks) pins the pid
//! against reuse. `<name>` is `clientInfo.name` from the MCP `initialize` request.
//!
//! This only groups connections and tells the service whether the client is alive. It is
//! not a credential: the token holder can always pass `session` explicitly.
//!
//! A Node-based Agent and a Node wrapper script look the same by image name, so `node.exe`
//! is not skipped; the real clients are verified one by one in W4j.

/// Image names (lower case) that only wrap the real client.
const WRAPPERS: &[&str] = &[
    "cmd.exe",
    "powershell.exe",
    "pwsh.exe",
    "bash.exe",
    "sh.exe",
    "conhost.exe",
];

/// Visible ASCII only, at most this many bytes in total (the service refuses anything else).
const MAX_HEADER: usize = 256;

/// `clientInfo.name` made safe for the header: visible ASCII kept, everything else `_`.
pub fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_ascii_graphic() { c } else { '_' })
        .take(100)
        .collect()
}

/// The full header value, or None when no ancestor could be identified.
pub fn header(client_name: Option<&str>) -> Option<String> {
    let (pid, created) = client_process()?;
    let mut value = format!("{pid}:{created}");
    if let Some(name) = client_name.map(sanitize).filter(|n| !n.is_empty()) {
        value.push('@');
        value.push_str(&name);
    }
    value.truncate(MAX_HEADER);
    Some(value)
}

/// (pid, creation FILETIME ticks) of the first non-wrapper ancestor.
pub fn client_process() -> Option<(u32, u64)> {
    let table = imp::processes()?;
    let mut pid = imp::parent_of(&table, std::process::id())?;
    // A bounded walk: parent links can form cycles after pid reuse.
    for _ in 0..16 {
        let name = table
            .iter()
            .find(|p| p.pid == pid)
            .map(|p| p.image.to_ascii_lowercase())?;
        if !WRAPPERS.contains(&name.as_str()) {
            return Some((pid, imp::created(pid)?));
        }
        pid = imp::parent_of(&table, pid)?;
    }
    None
}

/// When process `pid` started, in Unix milliseconds (the host's `runtime/host.json` records
/// the same), or `None` if it cannot be opened.
pub fn started_at_ms(pid: u32) -> Option<u64> {
    // FILETIME: 100 ns since 1601.
    imp::created(pid)?
        .checked_sub(116_444_736_000_000_000)
        .map(|t| t / 10_000)
}

pub struct Proc {
    pub pid: u32,
    pub parent: u32,
    pub image: String,
}

#[cfg(windows)]
mod imp {
    use super::Proc;
    use std::ffi::c_void;

    const TH32CS_SNAPPROCESS: u32 = 0x2;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

    #[repr(C)]
    struct ProcessEntry32W {
        size: u32,
        usage: u32,
        pid: u32,
        heap_id: usize,
        module_id: u32,
        threads: u32,
        parent: u32,
        priority: i32,
        flags: u32,
        exe: [u16; 260],
    }

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> *mut c_void;
        fn Process32FirstW(snapshot: *mut c_void, entry: *mut ProcessEntry32W) -> i32;
        fn Process32NextW(snapshot: *mut c_void, entry: *mut ProcessEntry32W) -> i32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn GetProcessTimes(
            process: *mut c_void,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    /// One snapshot of all processes (pid, parent pid, image name).
    pub fn processes() -> Option<Vec<Proc>> {
        // SAFETY: plain Win32 calls; the entry is sized as documented and the snapshot
        // handle is closed on every path that opened it.
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot.is_null() || snapshot as isize == -1 {
                return None;
            }
            let mut entry: ProcessEntry32W = std::mem::zeroed();
            entry.size = std::mem::size_of::<ProcessEntry32W>() as u32;
            let mut out = Vec::new();
            let mut ok = Process32FirstW(snapshot, &mut entry);
            while ok != 0 {
                let len = entry
                    .exe
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.exe.len());
                out.push(Proc {
                    pid: entry.pid,
                    parent: entry.parent,
                    image: String::from_utf16_lossy(&entry.exe[..len]),
                });
                ok = Process32NextW(snapshot, &mut entry);
            }
            CloseHandle(snapshot);
            Some(out)
        }
    }

    pub fn parent_of(table: &[Proc], pid: u32) -> Option<u32> {
        let parent = table.iter().find(|p| p.pid == pid)?.parent;
        // A parent created after its child is a reused pid, not the real parent.
        let (child, father) = (created(pid)?, created(parent)?);
        (father <= child).then_some(parent)
    }

    pub fn created(pid: u32) -> Option<u64> {
        // SAFETY: the handle is checked and closed; the FILETIMEs are plain out parameters.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return None;
            }
            let (mut c, mut e, mut k, mut u) = Default::default();
            let ok = GetProcessTimes(handle, &mut c, &mut e, &mut k, &mut u);
            CloseHandle(handle);
            let c: FileTime = c;
            (ok != 0).then(|| (u64::from(c.high) << 32) | u64::from(c.low))
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::Proc;

    pub fn processes() -> Option<Vec<Proc>> {
        None
    }

    pub fn parent_of(_: &[Proc], _: u32) -> Option<u32> {
        None
    }

    pub fn created(_: u32) -> Option<u64> {
        None
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn names_are_reduced_to_visible_ascii() {
        assert_eq!(sanitize("claude-code"), "claude-code");
        assert_eq!(sanitize("Claude Desktop 中文\r\n"), "Claude_Desktop_____");
        assert_eq!(sanitize(&"x".repeat(300)).len(), 100);
    }

    #[test]
    fn the_client_is_the_first_non_wrapper_ancestor() {
        // Under cargo test the parent is cargo (not a wrapper): the value is stable and has
        // the documented shape.
        let (pid, created) = client_process().expect("an ancestor");
        assert_ne!(pid, std::process::id());
        assert!(created > 0);
        assert_eq!(client_process(), Some((pid, created)));
        let value = header(Some("claude-code")).unwrap();
        assert_eq!(value, format!("{pid}:{created}@claude-code"));
        assert!(value.bytes().all(|b| b.is_ascii_graphic()));
        assert_eq!(header(None).unwrap(), format!("{pid}:{created}"));
    }
}

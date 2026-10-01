//! Install state and admission rules (de-electron plan §3.0, §6).
//!
//! Every host process, the root launcher and the setup read the same two files under the
//! install root:
//!
//! * `app.json` — the only version selector, `{current, previous}`, replaced atomically by
//!   setup and never written by a running host;
//! * `state\install.json` — the transaction journal; a transaction that has not reached a
//!   terminal outcome is a barrier for normal starts.
//!
//! Admission is decided here once so that the launcher, a host started from a physical
//! path, a host woken by the MCP shim and a host started by setup cannot disagree.

#[cfg(windows)]
pub mod ipc;

use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub const APP_POINTER: &str = "app.json";
pub const STATE_DIR: &str = "state";
pub const JOURNAL: &str = "install.json";
pub const LOCK: &str = "install.lock";
pub const PORTABLE_MARKER: &str = "portable";
const APP_DIR_PREFIX: &str = "app-";
/// Journal and pointer files are tiny; anything larger is corrupt, not data.
const MAX_STATE_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppPointer {
    pub current: String,
    #[serde(default)]
    pub previous: Option<String>,
}

/// What a transaction does. The state list is shared; the kind picks the path through it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TxnKind {
    /// First install or an update between new-style versions.
    #[default]
    Install,
    /// From a Squirrel/Electron 1.x install to the new layout (§6 steps 6–8).
    Migrate,
    /// Active rollback to `app.json.previous`: an ordinary activation (§6).
    Activate,
    /// Back to Electron: the reverse migration with its own steps and UNDO_LEGACY.
    Legacy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TxnState {
    Lock,
    Stage,
    Probe,
    Snapshot,
    Fence,
    Quiesce,
    Isolate,
    Seal,
    Switch,
    Start,
    Commit,
    /// The generic undo path; progress in `undo.step`.
    Undo,
    RollbackStart,
    #[serde(rename = "R_QUIESCE")]
    ReverseQuiesce,
    #[serde(rename = "R_RESTORE_LEGACY")]
    ReverseRestoreLegacy,
    #[serde(rename = "R_ISOLATE_NEW")]
    ReverseIsolateNew,
    #[serde(rename = "R_POINTER")]
    ReversePointer,
    #[serde(rename = "R_START_LEGACY")]
    ReverseStartLegacy,
    /// Failure branch of the reverse migration; progress in `undo.step`.
    UndoLegacy,
    Done,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Outcome {
    Committed,
    Aborted,
    RolledBack,
    RecoveryFailed,
}

/// Where an undo stands: the outcome it is heading for and the next step to run. A dead
/// setup's successor resumes from `step`, so every step is idempotent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoProgress {
    pub target: Outcome,
    pub step: u8,
}

/// A process pinned by pid and creation time (and the image it was started from), so a
/// recycled pid is never mistaken for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessIdentity {
    pub pid: u32,
    pub started_at_ms: u64,
    #[serde(default)]
    pub image: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transaction {
    pub id: String,
    /// The version before: `app.json.current` at LOCK (`legacy:<1.x>` for a migration),
    /// `None` for a first install.
    #[serde(default)]
    pub from: Option<String>,
    pub to: String,
    pub state: TxnState,
    #[serde(default)]
    pub outcome: Option<Outcome>,
    #[serde(default)]
    pub commit_pending: bool,
    #[serde(default)]
    pub snapshot_complete: bool,
    #[serde(default)]
    pub kind: TxnKind,
    /// Whether `from`'s service was running when the transaction began (UNDO_RESTART).
    #[serde(default)]
    pub from_running: bool,
    #[serde(default)]
    pub undo: Option<UndoProgress>,
    /// This transaction created `app-<to>` (STAGE). Undo deletes only what it created:
    /// an activation's target, or `app.json.previous`, is never removed.
    #[serde(default)]
    pub staged: bool,
    /// FENCE→QUIESCE→ISOLATE→SEAL rounds used (at most 3).
    #[serde(default)]
    pub seal_rounds: u8,
    /// The Electron process a reverse migration started (R_START_LEGACY).
    #[serde(default)]
    pub legacy: Option<ProcessIdentity>,
    /// The host setup started for START / ROLLBACK_START.
    #[serde(default)]
    pub started: Option<ProcessIdentity>,
    #[serde(default)]
    pub started_at_ms: u64,
    /// Short failure code of the step that sent the transaction into undo.
    #[serde(default)]
    pub error: Option<String>,
}

impl Transaction {
    pub fn new(id: String, from: Option<String>, to: String, kind: TxnKind) -> Self {
        Transaction {
            id,
            from,
            to,
            state: TxnState::Lock,
            outcome: None,
            commit_pending: false,
            snapshot_complete: false,
            kind,
            from_running: false,
            undo: None,
            staged: false,
            seal_rounds: 0,
            legacy: None,
            started: None,
            started_at_ms: 0,
            error: None,
        }
    }

    /// A transaction with an outcome no longer blocks anybody, except RECOVERY_FAILED,
    /// which must stop every start until a repair runs.
    pub fn is_terminal(&self) -> bool {
        self.state == TxnState::Done && self.outcome.is_some()
    }
}

#[derive(Debug)]
pub enum StateError {
    Io(io::Error),
    TooLarge(PathBuf),
    Invalid(PathBuf, String),
}

impl std::fmt::Display for StateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StateError::Io(error) => write!(f, "install state unreadable: {error}"),
            StateError::TooLarge(path) => write!(f, "install state too large: {}", path.display()),
            StateError::Invalid(path, detail) => {
                write!(f, "install state invalid: {}: {detail}", path.display())
            }
        }
    }
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>, StateError> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(StateError::Io(error)),
    };
    if metadata.len() > MAX_STATE_BYTES {
        return Err(StateError::TooLarge(path.to_path_buf()));
    }
    let bytes = fs::read(path).map_err(StateError::Io)?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| StateError::Invalid(path.to_path_buf(), error.to_string()))
}

/// Same rule as `resolveDaemonDataDirectory` in apps/daemon/src/runtime-discovery.ts. Host,
/// launcher and setup must agree on it: the second-instance pipe name hashes it.
pub fn data_dir() -> Result<PathBuf, String> {
    for key in ["ATM_DATA_DIR", "AYANAMI_TASK_DATA_DIR"] {
        if let Some(value) = std::env::var_os(key).filter(|value| !value.is_empty()) {
            return std::path::absolute(PathBuf::from(value)).map_err(|error| error.to_string());
        }
    }
    let local = std::env::var_os("LOCALAPPDATA").ok_or("ATM_DATA_DIRECTORY_UNAVAILABLE")?;
    Ok(PathBuf::from(local).join("AyanamiTaskManager"))
}

pub fn read_pointer(install_root: &Path) -> Result<Option<AppPointer>, StateError> {
    read_json(&install_root.join(APP_POINTER))
}

pub fn read_journal(install_root: &Path) -> Result<Option<Transaction>, StateError> {
    read_json(&install_root.join(STATE_DIR).join(JOURNAL))
}

/// `app-2.0.0` → `2.0.0`. The directory name is the version identity of a layout.
pub fn app_dir_version(app_dir: &Path) -> Option<String> {
    let name = app_dir.file_name()?.to_str()?;
    let version = name.strip_prefix(APP_DIR_PREFIX)?;
    let valid = !version.is_empty()
        && version.len() <= 64
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'));
    valid.then(|| version.to_owned())
}

pub fn app_dir_for(install_root: &Path, version: &str) -> PathBuf {
    install_root.join(format!("{APP_DIR_PREFIX}{version}"))
}

/// Whether a live setup holds the install lock. The lock is an exclusively opened file:
/// the OS releases it when the holder dies, so a stale journal never blocks forever.
#[cfg(windows)]
pub fn lock_held(install_root: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    const ERROR_SHARING_VIOLATION: i32 = 32;
    let path = install_root.join(STATE_DIR).join(LOCK);
    match fs::OpenOptions::new().read(true).share_mode(0).open(&path) {
        Ok(_) => false,
        Err(error) => error.raw_os_error() == Some(ERROR_SHARING_VIOLATION),
    }
}

#[cfg(not(windows))]
pub fn lock_held(_install_root: &Path) -> bool {
    false
}

/// Stop this process's standard handles from leaking into the processes it starts.
///
/// std's `Command` creates every child with `bInheritHandles = TRUE`, so a child given
/// `Stdio::null()` still inherits every inheritable handle — including the pipe a caller
/// captured our output with. Launcher → setup → host passes it down hop by hop, and the
/// long-lived host then holds the caller's pipe open: `AyanamiTaskManager.exe --background`
/// run with captured output never reaches EOF. `Stdio::inherit()` duplicates the handle as
/// inheritable for that one child, so inherited stdio (headless routes) keeps working.
#[cfg(windows)]
pub fn stop_std_handle_inheritance() {
    use windows_sys::Win32::Foundation::{
        HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, SetHandleInformation,
    };
    use windows_sys::Win32::System::Console::{
        GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };
    for id in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
        let handle = unsafe { GetStdHandle(id) };
        if !handle.is_null() && handle != INVALID_HANDLE_VALUE {
            unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) };
        }
    }
}

#[cfg(not(windows))]
pub fn stop_std_handle_inheritance() {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchIntent {
    Normal,
    /// `--health-probe --txn <id>`
    Probe(String),
    /// `--txn-start <id>`
    TxnStart(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Context {
    InstalledNormal {
        install_root: PathBuf,
        version: String,
    },
    SetupProbe {
        install_root: PathBuf,
        version: String,
        txn: String,
    },
    TxnStart {
        install_root: PathBuf,
        version: String,
        txn: String,
    },
    Portable,
    Unknown,
}

/// Classify the process from its own verified location. Transaction intents only apply
/// when the journal, the lock and the version agree; otherwise the process is treated as
/// an ordinary installed start and goes through the barrier.
pub fn detect_context(
    app_dir: &Path,
    intent: &LaunchIntent,
    read_journal_at: impl Fn(&Path) -> Result<Option<Transaction>, StateError>,
    lock_held_at: impl Fn(&Path) -> bool,
) -> Context {
    let Some(install_root) = app_dir.parent() else {
        return Context::Unknown;
    };
    let version = app_dir_version(app_dir);
    let installed = install_root.join(APP_POINTER).is_file()
        || install_root.join(STATE_DIR).join(JOURNAL).is_file();
    if !installed {
        return if app_dir.join(PORTABLE_MARKER).is_file() {
            Context::Portable
        } else {
            Context::Unknown
        };
    }
    let Some(version) = version else {
        return Context::Unknown;
    };
    let root = install_root.to_path_buf();
    let journal = read_journal_at(install_root).ok().flatten();
    let bound = |txn: &str, allowed: &[TxnState]| {
        journal.as_ref().is_some_and(|journal| {
            journal.id == txn
                && allowed.contains(&journal.state)
                && journal_target(journal) == Some(version.as_str())
        }) && lock_held_at(install_root)
    };
    match intent {
        LaunchIntent::Probe(txn) if bound(txn, &[TxnState::Probe]) => Context::SetupProbe {
            install_root: root,
            version,
            txn: txn.clone(),
        },
        LaunchIntent::TxnStart(txn) if bound(txn, &[TxnState::Start, TxnState::RollbackStart]) => {
            Context::TxnStart {
                install_root: root,
                version,
                txn: txn.clone(),
            }
        }
        _ => Context::InstalledNormal {
            install_root: root,
            version,
        },
    }
}

/// The version a START / ROLLBACK_START / PROBE transaction is allowed to run.
fn journal_target(journal: &Transaction) -> Option<&str> {
    match journal.state {
        TxnState::RollbackStart => journal.from.as_deref(),
        _ => Some(journal.to.as_str()),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Admission {
    Proceed,
    /// This installed version is not `app.json.current`: hand the same arguments to the
    /// root launcher and exit, so old physical paths always land on the current version.
    RedirectToLauncher(PathBuf),
    /// A live setup is mid-transaction; wait (bounded) and ask again.
    WaitForInstaller,
    /// The journal is not terminal and nobody holds the lock: run `atm-setup --recover`.
    NeedsRecovery,
    /// A previous recovery failed; only a manual repair may continue.
    RecoveryFailed,
    Reject(&'static str),
}

pub fn admit(
    context: &Context,
    read_pointer_at: impl Fn(&Path) -> Result<Option<AppPointer>, StateError>,
    read_journal_at: impl Fn(&Path) -> Result<Option<Transaction>, StateError>,
    lock_held_at: impl Fn(&Path) -> bool,
) -> Admission {
    let (install_root, version) = match context {
        Context::Portable | Context::SetupProbe { .. } | Context::TxnStart { .. } => {
            return Admission::Proceed;
        }
        Context::Unknown => return Admission::Reject("LAYOUT_UNKNOWN"),
        Context::InstalledNormal {
            install_root,
            version,
        } => (install_root, version),
    };
    match read_journal_at(install_root) {
        Err(_) => return Admission::NeedsRecovery,
        Ok(Some(journal)) if journal.outcome == Some(Outcome::RecoveryFailed) => {
            return Admission::RecoveryFailed;
        }
        Ok(Some(journal)) if !journal.is_terminal() => {
            return if lock_held_at(install_root) {
                Admission::WaitForInstaller
            } else {
                Admission::NeedsRecovery
            };
        }
        Ok(_) => {}
    }
    match read_pointer_at(install_root) {
        Ok(Some(pointer)) if pointer.current == *version => Admission::Proceed,
        Ok(Some(_)) => Admission::RedirectToLauncher(install_root.clone()),
        Ok(None) | Err(_) => Admission::NeedsRecovery,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn txn(state: TxnState, outcome: Option<Outcome>) -> Transaction {
        let mut txn = Transaction::new(
            "t1".into(),
            Some("1.0.0".into()),
            "2.0.0".into(),
            TxnKind::Install,
        );
        txn.state = state;
        txn.outcome = outcome;
        txn.snapshot_complete = true;
        txn
    }

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn scratch(name: &str) -> Scratch {
        let dir =
            std::env::temp_dir().join(format!("atm-install-state-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("app-2.0.0")).unwrap();
        Scratch(dir)
    }

    #[test]
    fn version_comes_from_the_directory_name_only() {
        assert_eq!(
            app_dir_version(Path::new("C:/x/app-2.0.0")).as_deref(),
            Some("2.0.0")
        );
        assert_eq!(
            app_dir_version(Path::new("C:/x/app-2.0.0-rc.1")).as_deref(),
            Some("2.0.0-rc.1")
        );
        assert_eq!(app_dir_version(Path::new("C:/x/app-")), None);
        assert_eq!(app_dir_version(Path::new("C:/x/app-1 2")), None);
        assert_eq!(app_dir_version(Path::new("C:/x/current")), None);
    }

    #[test]
    fn portable_and_unknown_layouts() {
        let root = scratch("portable");
        let app = root.0.join("app-2.0.0");
        let none = |_: &Path| Ok(None);
        assert_eq!(
            detect_context(&app, &LaunchIntent::Normal, none, |_| false),
            Context::Unknown
        );
        fs::write(app.join(PORTABLE_MARKER), b"").unwrap();
        assert_eq!(
            detect_context(&app, &LaunchIntent::Normal, none, |_| false),
            Context::Portable
        );
    }

    #[test]
    fn txn_intents_need_journal_lock_and_version_to_agree() {
        let root = scratch("intents");
        fs::write(root.0.join(APP_POINTER), br#"{"current":"1.0.0"}"#).unwrap();
        let app = root.0.join("app-2.0.0");
        let journal = RefCell::new(txn(TxnState::Start, None));
        let read = |_: &Path| Ok(Some(journal.borrow().clone()));
        let start = LaunchIntent::TxnStart("t1".into());
        assert!(matches!(
            detect_context(&app, &start, read, |_| true),
            Context::TxnStart { .. }
        ));
        // Lock released (setup died): the parameter grants nothing.
        assert!(matches!(
            detect_context(&app, &start, read, |_| false),
            Context::InstalledNormal { .. }
        ));
        // Wrong id, wrong state.
        assert!(matches!(
            detect_context(&app, &LaunchIntent::TxnStart("t2".into()), read, |_| true),
            Context::InstalledNormal { .. }
        ));
        journal.replace(txn(TxnState::Probe, None));
        assert!(matches!(
            detect_context(&app, &start, read, |_| true),
            Context::InstalledNormal { .. }
        ));
        assert!(matches!(
            detect_context(&app, &LaunchIntent::Probe("t1".into()), read, |_| true),
            Context::SetupProbe { .. }
        ));
        // ROLLBACK_START runs `from`, never `to`.
        journal.replace(txn(TxnState::RollbackStart, None));
        assert!(matches!(
            detect_context(&app, &start, read, |_| true),
            Context::InstalledNormal { .. }
        ));
    }

    #[test]
    fn barrier_redirect_and_recovery() {
        let root = PathBuf::from("C:/atm");
        let installed = Context::InstalledNormal {
            install_root: root.clone(),
            version: "2.0.0".into(),
        };
        let pointer = |current: &'static str| {
            move |_: &Path| {
                Ok(Some(AppPointer {
                    current: current.into(),
                    previous: None,
                }))
            }
        };
        let no_journal = |_: &Path| Ok(None);
        assert_eq!(
            admit(&installed, pointer("2.0.0"), no_journal, |_| false),
            Admission::Proceed
        );
        assert_eq!(
            admit(&installed, pointer("1.0.0"), no_journal, |_| false),
            Admission::RedirectToLauncher(root.clone())
        );
        let running = |_: &Path| Ok(Some(txn(TxnState::Quiesce, None)));
        assert_eq!(
            admit(&installed, pointer("2.0.0"), running, |_| true),
            Admission::WaitForInstaller
        );
        assert_eq!(
            admit(&installed, pointer("2.0.0"), running, |_| false),
            Admission::NeedsRecovery
        );
        let failed = |_: &Path| Ok(Some(txn(TxnState::Done, Some(Outcome::RecoveryFailed))));
        assert_eq!(
            admit(&installed, pointer("2.0.0"), failed, |_| false),
            Admission::RecoveryFailed
        );
        let committed = |_: &Path| {
            let mut done = txn(TxnState::Done, Some(Outcome::Committed));
            done.commit_pending = true;
            Ok(Some(done))
        };
        // commitPending never blocks a start.
        assert_eq!(
            admit(&installed, pointer("2.0.0"), committed, |_| false),
            Admission::Proceed
        );
        assert_eq!(
            admit(&installed, |_| Ok(None), no_journal, |_| false),
            Admission::NeedsRecovery
        );
        assert_eq!(
            admit(&Context::Unknown, pointer("2.0.0"), no_journal, |_| false),
            Admission::Reject("LAYOUT_UNKNOWN")
        );
    }

    #[test]
    fn oversized_or_corrupt_state_is_an_error_not_data() {
        let root = scratch("corrupt");
        fs::create_dir_all(root.0.join(STATE_DIR)).unwrap();
        fs::write(root.0.join(STATE_DIR).join(JOURNAL), b"{nope").unwrap();
        assert!(matches!(
            read_journal(&root.0),
            Err(StateError::Invalid(..))
        ));
        fs::write(
            root.0.join(APP_POINTER),
            vec![b' '; (MAX_STATE_BYTES + 1) as usize],
        )
        .unwrap();
        assert!(matches!(
            read_pointer(&root.0),
            Err(StateError::TooLarge(..))
        ));
    }
}

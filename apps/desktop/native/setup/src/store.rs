//! The install lock and the persisted transaction (§6): every step is written before it
//! runs, so a successor can tell exactly where a dead setup stopped.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::windows::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use atm_install_state::{AppPointer, Outcome, Transaction, TxnState, UndoProgress};

use crate::env::Env;
use crate::fsx;

/// Held for the life of the setup process; the OS drops it if setup dies, which is what
/// lets `lock_held` distinguish "installer busy" from "installer crashed".
pub struct InstallLock {
    _file: File,
}

pub fn acquire_lock(env: &Env, wait: Duration) -> io::Result<InstallLock> {
    let path = env.state_dir().join(atm_install_state::LOCK);
    fs::create_dir_all(env.state_dir())?;
    let deadline = Instant::now() + wait;
    loop {
        match OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .share_mode(0)
            .open(&path)
        {
            Ok(file) => return Ok(InstallLock { _file: file }),
            // A finishing uninstall removed the empty `state\` between our create and open.
            Err(error) if error.kind() == io::ErrorKind::NotFound && Instant::now() < deadline => {
                fs::create_dir_all(env.state_dir())?;
            }
            Err(error) if error.raw_os_error() == Some(32) && Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(250));
            }
            Err(error) if error.raw_os_error() == Some(32) => {
                return Err(io::Error::other(
                    "INSTALL_LOCK_BUSY: another setup is running",
                ));
            }
            Err(error) => return Err(error),
        }
    }
}

pub struct Store {
    journal: PathBuf,
    pointer: PathBuf,
}

impl Store {
    pub fn new(env: &Env) -> Store {
        Store {
            journal: env.state_dir().join(atm_install_state::JOURNAL),
            pointer: env.install_root.join(atm_install_state::APP_POINTER),
        }
    }

    pub fn load(&self, env: &Env) -> io::Result<Option<Transaction>> {
        atm_install_state::read_journal(&env.install_root)
            .map_err(|error| io::Error::other(error.to_string()))
    }

    pub fn save(&self, txn: &Transaction) -> io::Result<()> {
        fsx::write_json_atomic(&self.journal, txn)
    }

    pub fn pointer(&self, env: &Env) -> io::Result<Option<AppPointer>> {
        atm_install_state::read_pointer(&env.install_root)
            .map_err(|error| io::Error::other(error.to_string()))
    }

    pub fn set_pointer(&self, pointer: &AppPointer) -> io::Result<()> {
        fsx::write_json_atomic(&self.pointer, pointer)
    }

    pub fn remove_pointer(&self) -> io::Result<()> {
        match fs::remove_file(&self.pointer) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        }
    }
}

/// Persist the next state before doing its work.
pub fn enter(store: &Store, txn: &mut Transaction, state: TxnState) -> io::Result<()> {
    txn.state = state;
    store.save(txn)?;
    crate::fault::after_persist(state, txn.undo.map(|undo| undo.step));
    Ok(())
}

pub fn enter_undo(
    store: &Store,
    txn: &mut Transaction,
    state: TxnState,
    target: Outcome,
    step: u8,
) -> io::Result<()> {
    txn.undo = Some(UndoProgress { target, step });
    enter(store, txn, state)
}

/// A failed recovery keeps the state and undo step it failed in: the outcome holds the
/// barrier, and "ATM 修复" retries exactly that step instead of starting over or giving up.
pub fn recovery_failed(store: &Store, txn: &mut Transaction) -> io::Result<()> {
    txn.outcome = Some(Outcome::RecoveryFailed);
    store.save(txn)
}

pub fn finish(store: &Store, txn: &mut Transaction, outcome: Outcome) -> io::Result<()> {
    txn.outcome = Some(outcome);
    txn.state = TxnState::Done;
    store.save(txn)
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

pub fn new_txn_id() -> String {
    // Unique enough for one install root; never used as a secret.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in format!("{}-{}", now_ms(), std::process::id()).bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("t{:x}{:08x}", now_ms(), hash as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::legacy::legacy_pointer;
    use atm_install_state::TxnKind;

    fn scratch_env(name: &str) -> Env {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("target")
            .join("setup-tests")
            .join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let dir = std::path::absolute(dir).unwrap();
        Env {
            install_root: dir.join("install"),
            data_dir: dir.join("data"),
            v3_root: dir.join("v3-data"),
            start_menu_dir: dir.join("start-menu"),
            desktop_dir: dir.join("desktop"),
            // Never opened by these tests; a private name all the same.
            uninstall_key: r"Software\AyanamiTaskManagerUnitTest\Uninstall".into(),
            run_key: r"Software\AyanamiTaskManagerUnitTest\Run".into(),
            scheduler_dir: Some(dir.join("scheduler")),
            sandbox: true,
        }
    }

    /// W4i peer r4 P1-01：setup 自己写出的事务与 `app.json` 都读得回来，包括 `legacy:` 引用——迁移
    /// （`from = legacy:1.x`，之后 `previous = legacy:1.x`）、反向迁移（`to = legacy:1.x`，之后
    /// `current = legacy:1.x`）、普通更新与回滚。读不回来时恢复、维护、回滚与正常准入都会停在「状态损坏」。
    #[test]
    fn every_state_setup_writes_reads_back() {
        let env = scratch_env("store-read-back");
        fs::create_dir_all(env.state_dir()).unwrap();
        let store = Store::new(&env);
        let legacy = legacy_pointer("1.4.0");
        for (from, to, kind) in [
            (Some(legacy.clone()), "3.0.0".to_string(), TxnKind::Migrate),
            (Some("3.0.0".to_string()), legacy.clone(), TxnKind::Legacy),
            (
                Some("2.0.0".to_string()),
                "3.0.0".to_string(),
                TxnKind::Install,
            ),
            (None, "3.0.0-beta.1+build.7".to_string(), TxnKind::Install),
        ] {
            let mut txn = Transaction::new(new_txn_id(), from, to, kind);
            for state in [TxnState::Lock, TxnState::Switch, TxnState::Start] {
                enter(&store, &mut txn, state).unwrap();
                assert_eq!(
                    store.load(&env).unwrap().as_ref(),
                    Some(&txn),
                    "{kind:?} {state:?}"
                );
            }
        }
        for (current, previous) in [
            ("3.0.0".to_string(), Some(legacy.clone())),
            (legacy.clone(), Some("3.0.0".to_string())),
            ("3.0.0".to_string(), Some("2.0.0".to_string())),
            ("2.0.0".to_string(), Some("3.0.0".to_string())),
            ("3.0.0".to_string(), None),
        ] {
            let pointer = AppPointer { current, previous };
            store.set_pointer(&pointer).unwrap();
            assert_eq!(store.pointer(&env).unwrap(), Some(pointer));
        }
        let _ = fs::remove_dir_all(env.install_root.parent().unwrap());
    }
}

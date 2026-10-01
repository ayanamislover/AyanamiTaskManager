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

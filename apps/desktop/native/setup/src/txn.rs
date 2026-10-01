//! The install/update/migration state machine (de-electron plan v9 §6).
//!
//! Every state is persisted before its work runs (`store::enter`), every step is
//! idempotent, and every failure edge leads to a terminal outcome: COMMITTED, ABORTED
//! (nothing switched, the old service restarted if it had been running), ROLLED_BACK, or
//! RECOVERY_FAILED (a human runs "ATM 修复"). Restores always use the transaction's own
//! `from` and SNAPSHOT, never whatever `app.json.previous` happens to say.

use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use atm_install_state::{AppPointer, Outcome, Transaction, TxnKind, TxnState};

use crate::env::{self, Env};
use crate::fault;
use crate::fsx;
use crate::legacy::{self, Legacy};
use crate::package::{self, Package};
use crate::procs;
use crate::quiesce;
use crate::register;
use crate::runtime;
use crate::snapshot::{self, Snapshot};
use crate::store::{self, InstallLock, Store};
use atm_install_state::ipc;

const PROBE_TIMEOUT: Duration = Duration::from_secs(90);
const START_TIMEOUT: Duration = Duration::from_secs(60);
/// How long a replay waits for the host an earlier attempt started. That host may never
/// serve: having lost its transaction it goes through normal admission, finds the journal
/// unfinished and blocks on its own `--recover` — which waits for this one (P1-7 replay).
const TAKEOVER_TIMEOUT: Duration = Duration::from_secs(20);
const QUIESCE_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_SEAL_ROUNDS: u8 = 3;
const MAX_ATTEMPTS: u32 = 2;

pub struct Options {
    /// Terminate a service that will not quit (the user said so explicitly).
    pub force: bool,
    /// Start versions with their window (an update the user started from the app);
    /// otherwise in the background, as autostart would.
    pub show: bool,
}

pub struct Setup {
    pub env: Env,
    pub store: Store,
    options: Options,
    _lock: InstallLock,
}

type Step = Result<(), String>;

fn io(error: std::io::Error) -> String {
    error.to_string()
}

fn code(error: &str) -> String {
    error
        .split(|c: char| c == ':' || c.is_whitespace())
        .next()
        .unwrap_or("FAILED")
        .chars()
        .take(64)
        .collect()
}

/// Where a failed or interrupted forward path ends. Before SWITCH nothing changed:
/// ABORTED. After it, ROLLED_BACK — unless nothing was installed before: a first install
/// has nothing to roll back to, it is ABORTED as well (Codex P2-2).
fn failure_outcome(txn: &Transaction) -> Outcome {
    match txn.state {
        _ if txn.from.is_none() => Outcome::Aborted,
        TxnState::Fence | TxnState::Quiesce | TxnState::Isolate | TxnState::Seal => {
            Outcome::Aborted
        }
        _ => Outcome::RolledBack,
    }
}

impl Setup {
    pub fn open(env: Env, options: Options) -> Result<Setup, String> {
        let lock = store::acquire_lock(&env, Duration::from_secs(10)).map_err(io)?;
        Ok(Setup {
            store: Store::new(&env),
            env,
            options,
            _lock: lock,
        })
    }

    fn enter(&self, txn: &mut Transaction, state: TxnState) -> Step {
        store::enter(&self.store, txn, state).map_err(io)?;
        if fault::fail_at(state) {
            return Err(format!("DRILL_FAIL_AT: {state:?}"));
        }
        Ok(())
    }

    // ---- attempts: the same target failing twice is not retried automatically ----

    fn attempts_path(&self) -> PathBuf {
        self.env.state_dir().join("attempts.json")
    }
    fn attempts(&self) -> std::collections::BTreeMap<String, u32> {
        fsx::read_json_limited(&self.attempts_path(), 64 * 1024)
            .ok()
            .flatten()
            .unwrap_or_default()
    }
    fn record_attempt(&self, version: &str, succeeded: bool) {
        let mut attempts = self.attempts();
        if succeeded {
            attempts.remove(version);
        } else {
            *attempts.entry(version.into()).or_default() += 1;
        }
        let _ = fsx::write_json_atomic(&self.attempts_path(), &attempts);
    }

    // ---- entry points ----

    /// Install, update, or migrate from Squirrel, to the version in `package`.
    pub fn install(&mut self, package: &Package, retry: bool) -> Result<Outcome, String> {
        self.recover_if_needed()?;
        let to = package.manifest.version.clone();
        if !retry && self.attempts().get(&to).copied().unwrap_or(0) >= MAX_ATTEMPTS {
            return Err(format!(
                "INSTALL_REFUSED: {to} failed {MAX_ATTEMPTS} times; run with --retry after fixing the cause"
            ));
        }
        // PRECHECK (§6 step 1): no transaction exists yet; failure changes nothing.
        package::verify_archive(package).map_err(io)?;
        let webview = crate::webview2::check(&package.manifest.min_web_view2)?;
        say!("precheck: package {to} ok, WebView2 {webview}");
        self.check_disk(package)?;
        let pointer = self.store.pointer(&self.env).map_err(io)?;
        let legacy = legacy::detect(&self.env.install_root);
        let (kind, from) = match (&pointer, &legacy) {
            (Some(pointer), _) if legacy::parse_legacy_pointer(&pointer.current).is_none() => {
                (TxnKind::Install, Some(pointer.current.clone()))
            }
            (_, Some(legacy)) => (
                TxnKind::Migrate,
                Some(legacy::legacy_pointer(&legacy.version)),
            ),
            (Some(pointer), None) => {
                return Err(format!(
                    "PRECHECK_INCONSISTENT: app.json says {} but no Electron install is present",
                    pointer.current
                ));
            }
            (None, None) => (TxnKind::Install, None),
        };
        if from.as_deref() == Some(to.as_str()) {
            let installed = self.env.app_dir(&to);
            return match package::verify_tree(&package.manifest, &installed) {
                Ok(()) => Err(format!("ALREADY_INSTALLED: {to}")),
                Err(_) => Err(format!(
                    "SAME_VERSION_DIFFERENT_CONTENT: {to} is installed with other content; refusing"
                )),
            };
        }
        let target = self.env.app_dir(&to);
        let previous = pointer
            .as_ref()
            .and_then(|pointer| pointer.previous.clone());
        let mut reuse = false;
        if target.exists() {
            if legacy::is_electron_dir(&target) {
                // Same version number as the Electron install: that directory is the old app
                // itself (and ISOLATE would move it). Never staged over, never deleted.
                return Err(format!(
                    "PRECHECK_VERSION_IS_LEGACY: app-{to} is the Electron install; package a newer version"
                ));
            }
            if package::verify_tree(&package.manifest, &target).is_ok() {
                reuse = true;
            } else if previous.as_deref() == Some(to.as_str()) {
                return Err(format!(
                    "PRECHECK_PREVIOUS_DIFFERS: app-{to} is the previous version with other content"
                ));
            } else {
                // A leftover nobody points at (an aborted stage from an older setup).
                fsx::remove_tree_within(&target, &self.env.install_root).map_err(io)?;
            }
        }
        let mut txn = Transaction::new(store::new_txn_id(), from, to.clone(), kind);
        txn.started_at_ms = store::now_ms();
        txn.from_running = quiesce::service_running(&self.env);
        say!(
            "LOCK {} {:?} {:?} -> {to} (service running: {})",
            txn.id,
            kind,
            txn.from,
            txn.from_running
        );
        self.enter(&mut txn, TxnState::Lock)?;
        self.cleanup_before(&txn);
        let outcome = self.forward(&mut txn, Some(package), reuse, legacy);
        self.record_attempt(
            &to,
            outcome
                .as_ref()
                .is_ok_and(|outcome| *outcome == Outcome::Committed),
        );
        outcome
    }

    /// Active rollback to `app.json.previous` (an ordinary activation), or back to Electron.
    pub fn rollback(&mut self) -> Result<Outcome, String> {
        self.recover_if_needed()?;
        let pointer = self
            .store
            .pointer(&self.env)
            .map_err(io)?
            .ok_or("ROLLBACK_NOT_INSTALLED")?;
        let previous = pointer.previous.clone().ok_or("ROLLBACK_NO_PREVIOUS")?;
        if let Some(version) = legacy::parse_legacy_pointer(&previous) {
            return crate::reverse::run(self, &pointer, version);
        }
        if !legacy::is_new_style_dir(&self.env.app_dir(&previous)) {
            return Err(format!("ROLLBACK_PREVIOUS_MISSING: app-{previous}"));
        }
        let mut txn = Transaction::new(
            store::new_txn_id(),
            Some(pointer.current.clone()),
            previous.clone(),
            TxnKind::Activate,
        );
        txn.started_at_ms = store::now_ms();
        txn.from_running = quiesce::service_running(&self.env);
        say!("LOCK {} Activate {} -> {previous}", txn.id, pointer.current);
        self.enter(&mut txn, TxnState::Lock)?;
        self.forward(&mut txn, None, true, None)
    }

    fn recover_if_needed(&mut self) -> Result<(), String> {
        if let Some(mut txn) = self.store.load(&self.env).map_err(io)? {
            if txn.outcome == Some(Outcome::RecoveryFailed) {
                return Err(
                    "RECOVERY_FAILED: 上一次安装没能撤销干净，请先运行开始菜单里的「ATM 修复」"
                        .into(),
                );
            }
            if !txn.is_terminal() {
                say!(
                    "found unfinished transaction {} at {:?}; recovering first",
                    txn.id,
                    txn.state
                );
                if self.recover()? == Outcome::RecoveryFailed {
                    return Err("RECOVERY_FAILED: 未完成的事务没能撤销，请运行「ATM 修复」".into());
                }
            } else if txn.commit_pending {
                self.finish_commit(&mut txn);
            }
        }
        Ok(())
    }

    fn check_disk(&self, package: &Package) -> Step {
        use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
        let probe = if self.env.install_root.exists() {
            self.env.install_root.clone()
        } else {
            self.env
                .install_root
                .parent()
                .map(PathBuf::from)
                .unwrap_or_default()
        };
        let mut free = 0u64;
        let ok = unsafe {
            GetDiskFreeSpaceExW(
                fsx::wide(&probe).as_ptr(),
                &mut free,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        // Staged copy + log/journal headroom; the zip already sits on this machine.
        let needed = package.manifest.unpacked_bytes + 64 * 1024 * 1024;
        if ok != 0 && free < needed {
            return Err(format!(
                "PRECHECK_DISK_FULL: {free} bytes free, {needed} needed"
            ));
        }
        Ok(())
    }

    // ---- the forward path ----

    fn forward(
        &mut self,
        txn: &mut Transaction,
        package: Option<&Package>,
        reuse: bool,
        legacy: Option<Legacy>,
    ) -> Result<Outcome, String> {
        match self.forward_steps(txn, package, reuse, legacy) {
            Ok(()) => Ok(Outcome::Committed),
            Err(error) => {
                say!("{:?} failed: {error}", txn.state);
                txn.error = Some(code(&error));
                let outcome = self.fail(txn)?;
                Err(format!("{error} (outcome {outcome:?})"))
            }
        }
    }

    fn forward_steps(
        &mut self,
        txn: &mut Transaction,
        package: Option<&Package>,
        reuse: bool,
        legacy: Option<Legacy>,
    ) -> Step {
        let to = txn.to.clone();
        let target = self.env.app_dir(&to);
        // STAGE (§6 step 3)
        self.enter(txn, TxnState::Stage)?;
        if !reuse {
            let package = package.ok_or("STAGE_WITHOUT_PACKAGE")?;
            let staging = self
                .env
                .txn_dir(&txn.id)
                .join("staging")
                .join(format!("app-{to}"));
            if staging.exists() {
                fsx::remove_tree_within(&staging, &self.env.install_root).map_err(io)?;
            }
            package::extract(package, &staging).map_err(io)?;
            txn.staged = true;
            self.store.save(txn).map_err(io)?;
            fsx::move_path(&staging, &target).map_err(io)?;
            say!(
                "STAGE app-{to} verified ({} files)",
                package.manifest.files.len()
            );
        }
        // PROBE (§6 step 4): read-only, alongside the running old version.
        self.enter(txn, TxnState::Probe)?;
        self.probe(txn)?;
        // SNAPSHOT (§6 step 5)
        self.enter(txn, TxnState::Snapshot)?;
        let pointer = self.store.pointer(&self.env).map_err(io)?;
        let snap = snapshot::take(&self.env, &txn.id, pointer, legacy.clone())?;
        if txn.kind == TxnKind::Migrate {
            // The only source for a later "back to Electron"; lives as long as the assets.
            fsx::write_json_atomic(&legacy::migration_record(&self.env.rollback_dir()), &snap)
                .map_err(io)?;
        }
        txn.snapshot_complete = true;
        self.store.save(txn).map_err(io)?;
        if txn.kind == TxnKind::Migrate {
            fault::squirrel_adds(&self.env.install_root);
        }
        // FENCE → QUIESCE → ISOLATE → SEAL, at most three rounds (§6 steps 6–8a).
        loop {
            txn.seal_rounds += 1;
            self.enter(txn, TxnState::Fence)?;
            self.fence(txn, &snap)?;
            self.enter(txn, TxnState::Quiesce)?;
            self.quiesce(txn)?;
            if txn.kind == TxnKind::Migrate {
                self.enter(txn, TxnState::Isolate)?;
                self.isolate(txn, &snap)?;
            }
            self.enter(txn, TxnState::Seal)?;
            match self.seal(txn, &snap) {
                Ok(()) => break,
                Err(error) if txn.seal_rounds < MAX_SEAL_ROUNDS => {
                    say!(
                        "SEAL round {} not established: {error}; again",
                        txn.seal_rounds
                    );
                }
                Err(error) => return Err(format!("SEAL_FAILED: {error}")),
            }
        }
        // SWITCH (§6 step 9)
        self.enter(txn, TxnState::Switch)?;
        self.store
            .set_pointer(&AppPointer {
                current: to.clone(),
                previous: txn.from.clone(),
            })
            .map_err(io)?;
        say!("SWITCH app.json.current = {to}");
        // START (§6 step 10)
        self.enter(txn, TxnState::Start)?;
        self.start(txn, &to)?;
        // COMMIT (§6 step 11)
        self.enter(txn, TxnState::Commit)?;
        self.commit(txn, &snap);
        Ok(())
    }

    fn probe(&self, txn: &Transaction) -> Step {
        let host = self.env.app_dir(&txn.to).join(env::LAUNCHER);
        let report_path = self.env.health_dir().join(format!("probe-{}.json", txn.id));
        let _ = fs::remove_file(&report_path);
        let (mut child, identity) =
            procs::spawn(&host, &["--health-probe", "--txn", &txn.id]).map_err(io)?;
        let deadline = Instant::now() + PROBE_TIMEOUT;
        let status = loop {
            if let Some(status) = child.try_wait().map_err(io)? {
                break status;
            }
            if Instant::now() >= deadline {
                procs::terminate(&identity);
                return Err("PROBE_TIMEOUT".into());
            }
            std::thread::sleep(Duration::from_millis(200));
        };
        let report: Option<serde_json::Value> =
            fsx::read_json_limited(&report_path, 256 * 1024).map_err(io)?;
        let Some(report) = report else {
            return Err(format!("PROBE_NO_REPORT: host exited {:?}", status.code()));
        };
        say!("PROBE report: {report}");
        if status.code() != Some(0) || report.get("ok") != Some(&serde_json::Value::Bool(true)) {
            let code = report
                .get("code")
                .and_then(|code| code.as_str())
                .unwrap_or("PROBE_FAILED");
            return Err(format!("PROBE_FAILED: {code}"));
        }
        Ok(())
    }

    fn fence(&self, txn: &Transaction, snap: &Snapshot) -> Step {
        let source = self.env.app_dir(&txn.to);
        if txn.kind == TxnKind::Migrate {
            // Keep the Squirrel stub for a later reverse migration before replacing it.
            let stub = self.env.launcher();
            let saved = legacy::saved_stub(&self.env.rollback_dir());
            if !saved.is_file() {
                let original = snapshot::saved_root_file(&self.env, &snap.txn, env::LAUNCHER);
                if original.is_file() {
                    fs::create_dir_all(saved.parent().unwrap_or(&self.env.install_root))
                        .map_err(io)?;
                    fs::copy(&original, &saved).map_err(io)?;
                } else if stub.is_file() {
                    return Err("FENCE_STUB_NOT_SNAPSHOTTED".into());
                }
            }
        }
        for (from, relative) in env::stable_sources(&source) {
            fsx::replace_file(&self.env.install_root.join(relative), &from)
                .map_err(|error| format!("FENCE_ROOT_FILE: {relative}: {error}"))?;
        }
        fsx::retarget_junction(&self.env.current_link(), &self.env.install_root)
            .map_err(|error| format!("FENCE_CURRENT: {error}"))?;
        say!("FENCE root files and current -> install root");
        Ok(())
    }

    fn quiesce(&self, txn: &Transaction) -> Step {
        match txn.kind {
            TxnKind::Migrate => quiesce::stop_legacy(
                &self.env,
                self.options.force,
                txn.started_at_ms,
                QUIESCE_TIMEOUT,
            ),
            _ => quiesce::stop_new_style(&self.env, self.options.force, QUIESCE_TIMEOUT),
        }
    }

    fn legacy_items_path(&self, txn: &Transaction) -> PathBuf {
        self.env.txn_dir(&txn.id).join("legacy-items.json")
    }

    /// The Squirrel items this transaction moves: the snapshot's, plus any the updater
    /// produced later (recorded before they are moved, so an undo puts them back too).
    fn legacy_items(&self, txn: &Transaction, snap: &Snapshot) -> Vec<String> {
        let base = snap
            .legacy
            .as_ref()
            .map(|legacy| legacy.items.clone())
            .unwrap_or_default();
        let recorded: Vec<String> = fsx::read_json_limited(&self.legacy_items_path(txn), 64 * 1024)
            .ok()
            .flatten()
            .unwrap_or_default();
        legacy::with_new_items(&base, recorded).unwrap_or(base)
    }

    fn isolate(&self, txn: &Transaction, snap: &Snapshot) -> Step {
        snap.legacy.as_ref().ok_or("ISOLATE_WITHOUT_LEGACY")?;
        let mut items = self.legacy_items(txn, snap);
        if let Some(all) =
            legacy::with_new_items(&items, legacy::scan_items(&self.env.install_root))
        {
            // Write-ahead: the transaction's list and the reverse-migration record first.
            fsx::write_json_atomic(&self.legacy_items_path(txn), &all).map_err(io)?;
            let record = legacy::migration_record(&self.env.rollback_dir());
            if let Ok(Some(mut migration)) = fsx::read_json_limited::<Snapshot>(&record, 16 << 20)
                && let Some(legacy) = migration.legacy.as_mut()
            {
                legacy.items = all.clone();
                fsx::write_json_atomic(&record, &migration).map_err(io)?;
            }
            say!(
                "ISOLATE: Squirrel added {:?} since the snapshot",
                &all[items.len()..]
            );
            items = all;
        }
        legacy::move_items(
            &items,
            &self.env.install_root,
            &legacy::isolated_dir(&self.env.rollback_dir()),
        )
        .map_err(|error| format!("ISOLATE: {error}"))?;
        say!("ISOLATE moved {items:?}");
        Ok(())
    }

    /// SEAL (§6 step 8a): (i) old entries cannot start, (ii) no old service or lease holder
    /// is alive, (iii) `current` points at the install root — re-established every round.
    fn seal(&self, txn: &Transaction, snap: &Snapshot) -> Step {
        if let Some(legacy) = &snap.legacy {
            for item in &legacy.items {
                if self.env.install_root.join(item).exists() {
                    return Err(format!("(i) {item} is back in the install root"));
                }
            }
            let left = legacy::scan_items(&self.env.install_root);
            if !left.is_empty() {
                return Err(format!(
                    "(i) Squirrel entries in the install root: {left:?}"
                ));
            }
        }
        for (from, relative) in env::stable_sources(&self.env.app_dir(&txn.to)) {
            let root = self.env.install_root.join(relative);
            if fsx::sha256_file(&root).ok() != fsx::sha256_file(&from).ok() {
                return Err(format!("(i) {relative} is not the new file"));
            }
        }
        if txn.kind == TxnKind::Migrate {
            let app = quiesce::legacy_app(&self.env, txn.started_at_ms);
            if !app.is_empty() {
                return Err(format!("(ii) {} Electron process(es) alive", app.len()));
            }
        }
        if let Some((proc, _)) = quiesce::service(&self.env) {
            return Err(format!("(ii) lease still held by pid {}", proc.pid));
        }
        if ipc::primary_alive(&self.env.data_dir) {
            return Err("(ii) a host still holds the single-instance lock".into());
        }
        fsx::retarget_junction(&self.env.current_link(), &self.env.install_root)
            .map_err(|error| format!("(iii) {error}"))?;
        match fsx::link_state(&self.env.current_link()) {
            fsx::LinkState::Link(target) if fsx::same_path(&target, &self.env.install_root) => {
                Ok(())
            }
            other => Err(format!("(iii) current is {other:?}")),
        }
    }

    pub fn start_version(&self, txn: &mut Transaction, version: &str) -> Step {
        self.start(txn, version)
    }

    fn start(&self, txn: &mut Transaction, version: &str) -> Step {
        let host = self.env.app_dir(version).join(env::LAUNCHER);
        let _ = fs::remove_file(
            self.env
                .health_dir()
                .join(format!("service-{}.json", txn.id)),
        );
        let args: &[&str] = if self.options.show {
            &["--txn-start", &txn.id]
        } else {
            &["--txn-start", &txn.id, "--background"]
        };
        let (_child, identity) = procs::spawn(&host, args).map_err(io)?;
        txn.started = Some(identity.clone());
        self.store.save(txn).map_err(io)?;
        fault::after_spawn(txn.state);
        self.await_healthy(txn, version, &identity, START_TIMEOUT)
    }

    /// The host this transaction started for `version`, if a replay finds it still alive:
    /// take it over instead of starting a second one, which would only hand off to the
    /// first through the single-instance pipe and exit (Codex P1-7).
    fn started_host(
        &self,
        txn: &Transaction,
        version: &str,
    ) -> Option<atm_install_state::ProcessIdentity> {
        let started = txn.started.clone()?;
        let dir = self.env.app_dir(version);
        (procs::alive(&started) && fsx::is_within(std::path::Path::new(&started.image), &dir))
            .then_some(started)
    }

    fn await_healthy(
        &self,
        txn: &Transaction,
        version: &str,
        identity: &atm_install_state::ProcessIdentity,
        timeout: Duration,
    ) -> Step {
        let identity = identity.clone();
        let deadline = Instant::now() + timeout;
        let mut last = String::new();
        while Instant::now() < deadline {
            match runtime::service_healthy(
                &self.env.health_dir(),
                &self.env.runtime_dir(),
                &txn.id,
                version,
                &identity,
            ) {
                Ok(()) => {
                    say!("START {version} SERVICE_HEALTHY (host {})", identity.pid);
                    return Ok(());
                }
                Err(error) => last = error,
            }
            if !procs::alive(&identity) {
                return Err(format!("START_HOST_EXITED: {last}"));
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        Err(format!("START_TIMEOUT: {last}"))
    }

    /// COMMIT never rolls back: the service is healthy. Registration failures leave
    /// `commitPending` for the launcher/setup to finish later (§6 step 11).
    fn commit(&self, txn: &mut Transaction, snap: &Snapshot) {
        let first_install = txn.from.is_none();
        let mut result = register::commit(&self.env, &txn.to, snap, first_install);
        if let Err(error) = &result {
            say!("COMMIT registration failed once: {error}; retrying");
            result = register::commit(&self.env, &txn.to, snap, first_install);
        }
        txn.commit_pending = result.is_err();
        if let Err(error) = result {
            say!("COMMIT pending: {error}");
        }
        let _ = store::finish(&self.store, txn, Outcome::Committed);
        say!(
            "COMMITTED {} -> {}",
            txn.from.as_deref().unwrap_or("(none)"),
            txn.to
        );
    }

    // ---- failure: early abort or the undo path ----

    fn fail(&mut self, txn: &mut Transaction) -> Result<Outcome, String> {
        let early = !txn.snapshot_complete
            || matches!(
                txn.state,
                TxnState::Lock | TxnState::Stage | TxnState::Probe | TxnState::Snapshot
            );
        if early {
            return self.early_abort(txn);
        }
        self.undo(txn, failure_outcome(txn), 1)
    }

    /// Undo step 0 (§6): nothing outside this transaction's own staging was touched.
    fn early_abort(&mut self, txn: &mut Transaction) -> Result<Outcome, String> {
        if txn.kind == TxnKind::Legacy {
            // Before R_QUIESCE a reverse migration has changed nothing.
            store::finish(&self.store, txn, Outcome::Aborted).map_err(io)?;
            return Ok(Outcome::Aborted);
        }
        let target = self.env.app_dir(&txn.to);
        for proc in procs::under(&target) {
            if proc.started_at_ms() >= txn.started_at_ms {
                procs::terminate(&proc.identity());
            }
        }
        let staging = self.env.txn_dir(&txn.id).join("staging");
        let _ = fsx::remove_tree_within(&staging, &self.env.install_root);
        if txn.staged {
            fsx::remove_tree_within(&target, &self.env.install_root).map_err(io)?;
        }
        store::finish(&self.store, txn, Outcome::Aborted).map_err(io)?;
        say!("ABORTED early: {}", txn.error.as_deref().unwrap_or("?"));
        Ok(Outcome::Aborted)
    }

    pub fn undo(
        &mut self,
        txn: &mut Transaction,
        target: Outcome,
        from_step: u8,
    ) -> Result<Outcome, String> {
        let snap = snapshot::load(&self.env, &txn.id)?;
        let undo_started = store::now_ms();
        let mut step = from_step.max(1);
        while step <= 3 {
            store::enter_undo(&self.store, txn, TxnState::Undo, target, step).map_err(io)?;
            let attempt = |setup: &mut Self, txn: &mut Transaction| {
                if fault::fail_undo(step) {
                    return Err(format!("DRILL_FAIL_UNDO: {step}"));
                }
                setup.undo_step(txn, &snap, step, undo_started)
            };
            let mut result = attempt(self, txn);
            if let Err(error) = &result {
                say!("UNDO step {step} failed once: {error}; retrying");
                result = attempt(self, txn);
            }
            if let Err(error) = result {
                say!("RECOVERY_FAILED at undo step {step}: {error}");
                txn.error = Some(code(&error));
                store::recovery_failed(&self.store, txn).map_err(io)?;
                return Ok(Outcome::RecoveryFailed);
            }
            step += 1;
        }
        store::finish(&self.store, txn, target).map_err(io)?;
        say!(
            "{target:?}: back to {}",
            txn.from.as_deref().unwrap_or("(nothing installed)")
        );
        Ok(target)
    }

    fn undo_step(
        &mut self,
        txn: &mut Transaction,
        snap: &Snapshot,
        step: u8,
        undo_started: u64,
    ) -> Step {
        let to_dir = self.env.app_dir(&txn.to);
        match step {
            // UNDO_STOP
            1 => quiesce::stop_started(&self.env, txn.started.as_ref(), &to_dir),
            // UNDO_RESTORE
            2 => {
                match &snap.pointer {
                    Some(pointer) => self.store.set_pointer(pointer).map_err(io)?,
                    None => self.store.remove_pointer().map_err(io)?,
                }
                snapshot::restore_root_files(&self.env, snap)?;
                if snap.legacy.is_some() {
                    // Undo of ISOLATE, item by item (resumable; extra items included).
                    legacy::move_back(
                        &self.legacy_items(txn, snap),
                        &self.env.install_root,
                        &legacy::isolated_dir(&self.env.rollback_dir()),
                    )?;
                }
                snapshot::restore_current_link(&self.env, snap)?;
                snapshot::restore_registrations(&self.env, snap)?;
                let keep = snap.pointer.as_ref().is_some_and(|pointer| {
                    pointer.current == txn.to
                        || pointer.previous.as_deref() == Some(txn.to.as_str())
                });
                if txn.staged && !keep {
                    fsx::remove_tree_within(&to_dir, &self.env.install_root).map_err(io)?;
                }
                Ok(())
            }
            // UNDO_RESTART (ROLLBACK_START for a new-style `from`, with the dual-process
            // witness; a live lease alone proves nothing).
            3 => {
                if !txn.from_running {
                    return Ok(());
                }
                let Some(from) = txn.from.clone() else {
                    return Ok(());
                };
                if let Some(version) = legacy::parse_legacy_pointer(&from) {
                    return self.restart_legacy(version, undo_started).map(|_| ());
                }
                if let Some(started) = self.started_host(txn, &from) {
                    say!(
                        "ROLLBACK_START: taking over host {} started earlier",
                        started.pid
                    );
                    match self.await_healthy(txn, &from, &started, TAKEOVER_TIMEOUT) {
                        Ok(()) => return Ok(()),
                        Err(error) => {
                            say!(
                                "ROLLBACK_START: host {} never served ({error}); replacing it",
                                started.pid
                            );
                            procs::terminate(&started);
                            if !procs::wait_all_gone(
                                std::slice::from_ref(&started),
                                Duration::from_secs(10),
                            ) {
                                return Err(format!(
                                    "ROLLBACK_START_TAKEOVER: host {} did not exit",
                                    started.pid
                                ));
                            }
                        }
                    }
                }
                // Whatever serves now was not started by this transaction: stop it, start ours.
                quiesce::stop_new_style(&self.env, true, Duration::from_secs(30))?;
                store::enter_undo(
                    &self.store,
                    txn,
                    TxnState::RollbackStart,
                    txn.undo.map(|undo| undo.target).unwrap_or(Outcome::Aborted),
                    3,
                )
                .map_err(io)?;
                self.start(txn, &from)
            }
            _ => Ok(()),
        }
    }

    /// Start Electron 1.x again and wait until it serves: alive, the lease/daemon.json pid
    /// is in its tree, published after `since_ms`, port open.
    pub fn restart_legacy(
        &self,
        version: &str,
        since_ms: u64,
    ) -> Result<atm_install_state::ProcessIdentity, String> {
        // A replay may find the Electron an earlier attempt started already serving; a
        // second one would only hand off to it and exit.
        if let Some((proc, true)) = quiesce::service(&self.env)
            && proc.started_at_ms() >= since_ms
            && runtime::descriptor(&self.env.runtime_dir())
                .is_some_and(|published| runtime::port_open(&published.endpoint))
        {
            say!("legacy {version} already serving again (pid {})", proc.pid);
            return Ok(proc.identity());
        }
        let exe = self.env.app_dir(version).join(env::LAUNCHER);
        let (_child, identity) = procs::spawn(&exe, &["--background"]).map_err(io)?;
        let deadline = Instant::now() + START_TIMEOUT;
        while Instant::now() < deadline {
            if let Some(published) = runtime::descriptor(&self.env.runtime_dir()) {
                let in_tree = published.pid == identity.pid
                    || procs::parent_of(published.pid) == Some(identity.pid);
                let fresh =
                    procs::find(published.pid).is_some_and(|proc| proc.started_at_ms() >= since_ms);
                if in_tree && fresh && runtime::port_open(&published.endpoint) {
                    say!("legacy {version} serving again (pid {})", identity.pid);
                    return Ok(identity);
                }
            }
            if !procs::alive(&identity) {
                return Err("LEGACY_RESTART_EXITED".into());
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        Err("LEGACY_RESTART_TIMEOUT".into())
    }

    // ---- recovery dispatch (§6 table) ----

    pub fn recover(&mut self) -> Result<Outcome, String> {
        let Some(mut txn) = self.store.load(&self.env).map_err(io)? else {
            return Ok(Outcome::Committed);
        };
        say!(
            "recover {} at {:?} (undo {:?})",
            txn.id,
            txn.state,
            txn.undo
        );
        // Only "ATM 修复" retries a failed recovery (it clears the outcome first).
        if txn.outcome == Some(Outcome::RecoveryFailed) {
            return Ok(Outcome::RecoveryFailed);
        }
        if txn.state == TxnState::Done {
            if txn.commit_pending && txn.outcome == Some(Outcome::Committed) {
                self.finish_commit(&mut txn);
            }
            return Ok(txn.outcome.unwrap_or(Outcome::Committed));
        }
        match txn.state {
            _ if !txn.snapshot_complete && !matches!(txn.state, TxnState::ReverseQuiesce) => {
                self.early_abort(&mut txn)
            }
            TxnState::Lock | TxnState::Stage | TxnState::Probe | TxnState::Snapshot => {
                self.early_abort(&mut txn)
            }
            TxnState::Fence | TxnState::Quiesce | TxnState::Isolate | TxnState::Seal => {
                self.undo(&mut txn, Outcome::Aborted, 1)
            }
            TxnState::Switch | TxnState::Start => {
                let target = failure_outcome(&txn);
                self.undo(&mut txn, target, 1)
            }
            // A killed uninstall: only an uninstall run resumes it (it must run from a copy
            // outside the root it deletes); every start stays behind the barrier until then.
            TxnState::Uninstall => {
                Err("UNINSTALL_IN_PROGRESS: 卸载没有完成，请从系统「应用」里再卸载一次".into())
            }
            TxnState::Commit => {
                let snap = snapshot::load(&self.env, &txn.id)?;
                self.commit(&mut txn, &snap);
                Ok(Outcome::Committed)
            }
            TxnState::RollbackStart if txn.kind == TxnKind::Legacy => {
                match txn.undo.map(|undo| undo.step) {
                    Some(5) => crate::reverse::undo_legacy(self, &mut txn, 5),
                    _ => crate::reverse::recover_quiesce(self, &mut txn),
                }
            }
            TxnState::Undo | TxnState::RollbackStart => {
                let progress = txn.undo.ok_or("UNDO_WITHOUT_PROGRESS")?;
                self.undo(&mut txn, progress.target, progress.step)
            }
            TxnState::ReverseQuiesce => crate::reverse::recover_quiesce(self, &mut txn),
            TxnState::ReverseRestoreLegacy
            | TxnState::ReverseIsolateNew
            | TxnState::ReversePointer
            | TxnState::ReverseStartLegacy => crate::reverse::undo_legacy(self, &mut txn, 1),
            TxnState::UndoLegacy => {
                let step = txn.undo.map(|undo| undo.step).unwrap_or(1);
                crate::reverse::undo_legacy(self, &mut txn, step)
            }
            TxnState::Done => unreachable!(),
        }
    }

    /// `commitPending` left by a COMMIT whose registrations failed: finish them now.
    pub fn finish_commit(&self, txn: &mut Transaction) {
        let Ok(snap) = snapshot::load(&self.env, &txn.id) else {
            return;
        };
        if register::commit(&self.env, &txn.to, &snap, txn.from.is_none()).is_ok() {
            txn.commit_pending = false;
            let _ = self.store.save(txn);
            say!("commitPending finished for {}", txn.id);
        }
    }

    // ---- CLEANUP (§6 step 13): in the next transaction, only behind UI_CONFIRMED ----

    fn cleanup_before(&self, txn: &Transaction) {
        let Ok(Some(pointer)) = self.store.pointer(&self.env) else {
            return;
        };
        let confirmed = self
            .env
            .health_dir()
            .join(format!("ui-{}.json", pointer.current))
            .is_file();
        if !confirmed {
            return;
        }
        let keep = [
            Some(pointer.current.as_str()),
            pointer.previous.as_deref(),
            Some(txn.to.as_str()),
        ];
        for dir in fsx::list_dir(&self.env.install_root) {
            let Some(version) = atm_install_state::app_dir_version(&dir) else {
                continue;
            };
            if legacy::is_new_style_dir(&dir) && !keep.contains(&Some(version.as_str())) {
                match fsx::remove_tree_within(&dir, &self.env.install_root) {
                    Ok(()) => say!("CLEANUP removed app-{version}"),
                    Err(error) => say!("CLEANUP deferred app-{version}: {error}"),
                }
            }
        }
        // Electron assets stay while app.json.previous can still lead back to them.
        let previous_is_legacy = pointer
            .previous
            .as_deref()
            .is_some_and(|previous| legacy::parse_legacy_pointer(previous).is_some());
        if !previous_is_legacy {
            let rollback = self.env.rollback_dir();
            for dir in [
                legacy::isolated_dir(&rollback),
                legacy::newstyle_dir(&rollback),
                rollback.join("legacy-stub"),
            ] {
                if dir.exists() {
                    match fsx::remove_tree_within(&dir, &self.env.install_root) {
                        Ok(()) => say!("CLEANUP removed {}", dir.display()),
                        Err(error) => say!("CLEANUP deferred {}: {error}", dir.display()),
                    }
                }
            }
            let _ = fs::remove_file(legacy::migration_record(&rollback));
        }
        for dir in fsx::list_dir(&self.env.state_dir().join("txn")) {
            if dir.file_name().is_some_and(|name| name != txn.id.as_str()) {
                let _ = fsx::remove_tree_within(&dir, &self.env.install_root);
            }
        }
        fsx::sweep_aside(&self.env.install_root);
        fsx::sweep_aside(&self.env.install_root.join("resources"));
    }
}

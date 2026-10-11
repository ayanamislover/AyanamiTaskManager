//! The "AyanamiTaskManager 保活" scheduled task (B1, plan §5): COMMIT (and repair) registers
//! it for a 3.x version and removes it for anything else, an undo or the way back to Electron
//! puts back what SNAPSHOT saw, and uninstall removes it — only ever a task that runs this
//! install's root launcher.
//!
//! The scheduler is injected: a release build talks to the Windows Task Scheduler (COM); a
//! drill build (sandbox) and the unit tests use a folder, so they never register a real task.

use std::path::PathBuf;

use atm_install_state::keepalive::{self, Registration, TASK_NAME};
use atm_install_state::startup;
use serde::{Deserialize, Serialize};

use crate::env::Env;

pub trait Scheduler {
    /// The task's XML, `None` when there is no such task.
    fn get(&self, name: &str) -> Result<Option<String>, String>;
    fn put(&self, name: &str, xml: &str) -> Result<(), String>;
    /// No such task is not an error.
    fn delete(&self, name: &str) -> Result<(), String>;
}

/// A drill's or a test's scheduler: `<dir>\<name>.xml` per task.
pub struct Folder(pub PathBuf);

impl Folder {
    fn file(&self, name: &str) -> PathBuf {
        self.0.join(format!("{name}.xml"))
    }
}

impl Scheduler for Folder {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        match std::fs::read_to_string(self.file(name)) {
            Ok(xml) => Ok(Some(xml)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!("KEEPALIVE_READ: {error}")),
        }
    }
    fn put(&self, name: &str, xml: &str) -> Result<(), String> {
        atm_install_state::durable::write_atomic(&self.file(name), xml.as_bytes())
            .map_err(|error| format!("KEEPALIVE_REGISTER: {error}"))
    }
    fn delete(&self, name: &str) -> Result<(), String> {
        match std::fs::remove_file(self.file(name)) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                Err(format!("KEEPALIVE_DELETE: {error}"))
            }
            _ => Ok(()),
        }
    }
}

pub fn scheduler(env: &Env) -> Box<dyn Scheduler> {
    match &env.scheduler_dir {
        Some(dir) => Box::new(Folder(dir.clone())),
        None => {
            // A unit test never reaches the real Task Scheduler.
            #[cfg(test)]
            panic!("KEEPALIVE_REAL_SCHEDULER_IN_TEST");
            #[cfg(not(test))]
            Box::new(com::TaskService)
        }
    }
}

/// What SNAPSHOT saw, put back by an undo. `Unknown`: a snapshot from before the task
/// existed, or one whose read failed — the restore then follows the version it goes back to.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", content = "xml", rename_all = "camelCase")]
pub enum Kept {
    #[default]
    Unknown,
    Absent,
    Present(String),
}

pub fn snapshot(env: &Env) -> Kept {
    match scheduler(env).get(TASK_NAME) {
        Ok(Some(xml)) => Kept::Present(xml),
        Ok(None) => Kept::Absent,
        Err(error) => {
            say!("keepalive: {error}; an undo will follow the version it restores");
            Kept::Unknown
        }
    }
}

fn current_user() -> Option<String> {
    let user = std::env::var("USERNAME").ok().filter(|u| !u.is_empty())?;
    Some(
        match std::env::var("USERDOMAIN").ok().filter(|d| !d.is_empty()) {
            Some(domain) => format!(r"{domain}\{user}"),
            None => user,
        },
    )
}

/// `YYYY-MM-DDTHH:MM:SSZ`: the repeating trigger starts now, not at the next logon.
fn trigger_start(now_ms: u64) -> String {
    let iso = startup::iso_utc(now_ms);
    format!("{}Z", &iso[..19])
}

/// Delete the task if it is this install's; another install's task of the same name stays.
fn delete_ours(env: &Env, s: &dyn Scheduler) -> Result<bool, String> {
    match s.get(TASK_NAME)? {
        Some(xml) if keepalive::runs_launcher(&xml, &env.launcher()) => {
            s.delete(TASK_NAME)?;
            Ok(true)
        }
        Some(_) => {
            say!("keepalive: the task runs another install's launcher, kept");
            Ok(false)
        }
        None => Ok(false),
    }
}

fn record(env: &Env, registered: Result<bool, String>, reason: &str) {
    let at = startup::iso_utc(crate::store::now_ms());
    let registration = match registered {
        Ok(registered) => Registration {
            registered,
            at,
            reason: (!registered).then(|| reason.to_owned()),
        },
        Err(error) => {
            say!("keepalive: {error}");
            Registration {
                registered: false,
                at,
                reason: Some(error),
            }
        }
    };
    if let Err(error) = keepalive::write_registration(&env.install_root, &registration) {
        say!("keepalive: the registration record was not written: {error}");
    }
}

/// COMMIT (and repair): register for a 3.x version — pointing at this install's root
/// launcher — and remove this install's task for anything else (2.x does not know
/// `--ensure-running`). Never fails the COMMIT: the outcome goes to
/// `state\keepalive-task.json`, so nothing claims an automatic recovery that is not there.
pub fn settle(env: &Env, version: &str) {
    let s = scheduler(env);
    if startup::is_v3(version) {
        let xml = keepalive::task_xml(
            &env.launcher(),
            current_user().as_deref(),
            &trigger_start(crate::store::now_ms()),
        );
        let put = s.put(TASK_NAME, &xml);
        if put.is_ok() {
            say!("keepalive: task registered for {version}");
        }
        record(env, put.map(|()| true), "");
    } else {
        let deleted = delete_ours(env, s.as_ref());
        if let Ok(true) = deleted {
            say!("keepalive: task removed, {version} is not a 3.x version");
        }
        record(
            env,
            deleted.map(|_| false),
            &format!("{version} is not a 3.x version"),
        );
    }
}

/// An undo, a reverse migration: put back what SNAPSHOT saw. `back_to` is the version the
/// pointer returns to (`None`: nothing was installed before).
pub fn restore(env: &Env, kept: &Kept, back_to: Option<&str>) -> Result<(), String> {
    let s = scheduler(env);
    match kept {
        Kept::Present(xml) => {
            s.put(TASK_NAME, xml)?;
            record(
                env,
                Ok(keepalive::runs_launcher(xml, &env.launcher())),
                "the restored task runs another install's launcher",
            );
        }
        Kept::Absent => {
            delete_ours(env, s.as_ref())?;
            record(env, Ok(false), "there was no task before");
        }
        Kept::Unknown => match back_to {
            // `legacy:1.x` is not 3.x either.
            Some(version) if startup::is_v3(version) => settle(env, version),
            _ => {
                delete_ours(env, s.as_ref())?;
                record(env, Ok(false), "not a 3.x version");
            }
        },
    }
    Ok(())
}

/// Uninstall (and its resumed run).
pub fn remove(env: &Env) -> Result<(), String> {
    delete_ours(env, scheduler(env).as_ref()).map(|_| ())
}

/// The Windows Task Scheduler (2.0 API). A unit test build compiles it but never uses it.
#[cfg_attr(test, allow(dead_code))]
mod com {
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
    };
    use windows::Win32::System::TaskScheduler::{
        ITaskFolder, ITaskService, TASK_CREATE_OR_UPDATE, TASK_LOGON_INTERACTIVE_TOKEN,
        TaskScheduler,
    };
    use windows::Win32::System::Variant::VARIANT;
    use windows::core::BSTR;

    /// `HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)`: no such task.
    const NOT_FOUND: i32 = 0x8007_0002_u32 as i32;

    pub struct TaskService;

    fn root() -> Result<ITaskFolder, String> {
        // S_FALSE (already initialized) and RPC_E_CHANGED_MODE are both fine here.
        let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        let service: ITaskService =
            unsafe { CoCreateInstance(&TaskScheduler, None, CLSCTX_INPROC_SERVER) }
                .map_err(|e| format!("KEEPALIVE_SCHEDULER: {e}"))?;
        let empty = VARIANT::default();
        unsafe { service.Connect(&empty, &empty, &empty, &empty) }
            .map_err(|e| format!("KEEPALIVE_SCHEDULER: {e}"))?;
        unsafe { service.GetFolder(&BSTR::from("\\")) }
            .map_err(|e| format!("KEEPALIVE_SCHEDULER: {e}"))
    }

    impl super::Scheduler for TaskService {
        fn get(&self, name: &str) -> Result<Option<String>, String> {
            let folder = root()?;
            match unsafe { folder.GetTask(&BSTR::from(name)) } {
                Ok(task) => unsafe { task.Xml() }
                    .map(|xml| Some(xml.to_string()))
                    .map_err(|e| format!("KEEPALIVE_READ: {e}")),
                Err(e) if e.code().0 == NOT_FOUND => Ok(None),
                Err(e) => Err(format!("KEEPALIVE_READ: {e}")),
            }
        }
        fn put(&self, name: &str, xml: &str) -> Result<(), String> {
            let folder = root()?;
            let empty = VARIANT::default();
            unsafe {
                folder.RegisterTask(
                    &BSTR::from(name),
                    &BSTR::from(xml),
                    TASK_CREATE_OR_UPDATE.0,
                    &empty,
                    &empty,
                    TASK_LOGON_INTERACTIVE_TOKEN,
                    &empty,
                )
            }
            .map(|_| ())
            .map_err(|e| format!("KEEPALIVE_REGISTER: {e}"))
        }
        fn delete(&self, name: &str) -> Result<(), String> {
            let folder = root()?;
            match unsafe { folder.DeleteTask(&BSTR::from(name), 0) } {
                Ok(()) => Ok(()),
                Err(e) if e.code().0 == NOT_FOUND => Ok(()),
                Err(e) => Err(format!("KEEPALIVE_DELETE: {e}")),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn env(name: &str) -> Env {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("target")
            .join("setup-tests")
            .join("keepalive")
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
            uninstall_key: String::new(),
            run_key: String::new(),
            scheduler_dir: Some(dir.join("scheduler")),
            sandbox: true,
        }
    }

    fn task(env: &Env) -> Option<String> {
        scheduler(env).get(TASK_NAME).unwrap()
    }

    fn registered(env: &Env) -> Option<bool> {
        keepalive::read_registration(&env.install_root).map(|r| r.registered)
    }

    fn foreign(env: &Env) -> String {
        keepalive::task_xml(
            &env.install_root
                .with_file_name("other")
                .join("AyanamiTaskManager.exe"),
            None,
            "2026-10-11T00:00:00Z",
        )
    }

    /// COMMIT：3.x 注册（指向这个安装的根启动器），记下「已注册」；2.x 删掉自己的任务、记下没有自动恢复的原因。
    #[test]
    fn commit_registers_for_3x_and_removes_for_2x() {
        let env = env("commit");
        settle(&env, "3.0.0");
        let xml = task(&env).expect("registered");
        assert!(keepalive::runs_launcher(&xml, &env.launcher()));
        assert_eq!(registered(&env), Some(true));
        settle(&env, "3.0.1");
        assert!(task(&env).is_some(), "an update keeps it");
        settle(&env, "2.0.0");
        assert_eq!(task(&env), None, "2.x does not know --ensure-running");
        let record = keepalive::read_registration(&env.install_root).unwrap();
        assert!(!record.registered);
        assert!(record.reason.unwrap().contains("2.0.0"));
    }

    /// 别的安装的同名任务：回滚到 2.x、卸载都不删它。
    #[test]
    fn another_installs_task_is_never_removed() {
        let env = env("foreign");
        scheduler(&env).put(TASK_NAME, &foreign(&env)).unwrap();
        settle(&env, "2.0.0");
        assert_eq!(task(&env), Some(foreign(&env)));
        remove(&env).unwrap();
        assert_eq!(task(&env), Some(foreign(&env)));
        restore(&env, &Kept::Absent, Some("2.0.0")).unwrap();
        assert_eq!(task(&env), Some(foreign(&env)));
    }

    /// 撤销按快照放回：之前有就放回原样，之前没有就删掉；快照不知道（旧快照、读失败）就看回到的版本。
    #[test]
    fn an_undo_puts_back_what_the_snapshot_saw() {
        let env = env("restore");
        assert_eq!(snapshot(&env), Kept::Absent);
        settle(&env, "3.0.0");
        let before = snapshot(&env);
        let Kept::Present(xml) = &before else {
            panic!("{before:?}")
        };
        // 3.0.0 → 3.0.1 撤销：任务原样回来。
        scheduler(&env).delete(TASK_NAME).unwrap();
        restore(&env, &before, Some("3.0.0")).unwrap();
        assert_eq!(task(&env).as_deref(), Some(xml.as_str()));
        assert_eq!(registered(&env), Some(true));
        // 首装撤销（之前没有任务）：删掉。
        restore(&env, &Kept::Absent, None).unwrap();
        assert_eq!(task(&env), None);
        assert_eq!(registered(&env), Some(false));
        // 旧快照：回到 3.x 就注册，回到 2.x / Electron / 什么都没有就删。
        restore(&env, &Kept::Unknown, Some("3.0.0")).unwrap();
        assert!(task(&env).is_some());
        restore(&env, &Kept::Unknown, Some("legacy:1.9.0")).unwrap();
        assert_eq!(task(&env), None);
        settle(&env, "3.0.0");
        restore(&env, &Kept::Unknown, None).unwrap();
        assert_eq!(task(&env), None);
    }

    /// 快照里的任务跟着 snapshot.json 存取；没有这个字段的旧快照读成 Unknown。
    #[test]
    fn the_kept_task_round_trips_and_old_snapshots_read_unknown() {
        for kept in [Kept::Unknown, Kept::Absent, Kept::Present("<Task/>".into())] {
            let text = serde_json::to_string(&kept).unwrap();
            assert_eq!(serde_json::from_str::<Kept>(&text).unwrap(), kept);
        }
        #[derive(Deserialize)]
        struct Old {
            #[serde(default)]
            keepalive: Kept,
        }
        let old: Old = serde_json::from_str("{}").unwrap();
        assert_eq!(old.keepalive, Kept::Unknown);
    }

    /// 卸载（含中断后重跑）：删掉自己的任务，再删一次也不出错。
    #[test]
    fn uninstall_removes_the_task_and_can_run_again() {
        let env = env("uninstall");
        settle(&env, "3.0.0");
        remove(&env).unwrap();
        assert_eq!(task(&env), None);
        remove(&env).unwrap();
    }
}

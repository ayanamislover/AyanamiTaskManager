//! 本地更新的协调（W5g；06 T-UPD，2.0 `update-coordinator.ts`、`updater.ts`）。
//!
//! 更新源是数据根下的 `updates\`：发布链先写完整的 `atm-<v>-win-x64.zip`，最后写清单
//! `atm-<v>-win-x64.json`——清单在，包才算投递完。这里只「发现、告知、按用户意愿发起」；
//! 校验、切换、回滚都是安装根里 atm-setup 的事务，由宿主拉起（`host/src/update.rs`）。
//!
//! - 主体：周期检查是 job `update.check`（System）；用户手点的检查与「立即更新」只认 User，
//!   读状态要 `update.status`（03 §3）。Agent 都没有。
//! - 同一时刻只跑一次检查：撞在一起的调用等前一次跑完，拿它的结果，不再重跑。
//! - 启动时查一次，之后每 6 小时；上次发起的安装还没落定（事务日志没有 outcome）时 10 秒后复查，
//!   这期间不清理包（万一事务回滚，用户还要用它重试）。
//! - 便携版与源码运行（没有安装根）不参与，状态写 UPDATE_UNSUPPORTED。
//! - 诊断：`<N>\logs\update-status.json`（最后一次）与 `updater.ndjson`（256 KiB × 3 轮换），
//!   说明文字脱敏（令牌、本机路径）并截到 512 字。诊断写不进去也不影响更新本身。
//!
//! 投放目录在 3.0 根（`N\updates`）。发布脚本改投放到这里是 W8 的事（06 §8 第 3 条）。

use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use atm_domain::capability::{self, Capability};
use atm_domain::error::DomainError;
use atm_domain::principal::{JobId, Principal};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// 新版本在 START 阶段就已经跑起来了，事务要等见证核对完才写终态。
pub const SETTLE_RECHECK: Duration = Duration::from_secs(10);
const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;
const MAX_STATUS_BYTES: u64 = 64 * 1024;
const MAX_JOURNAL_BYTES: u64 = 1024 * 1024;
const LOG_BYTES: u64 = 256 * 1024;
const LOG_FILES: usize = 3;
const MAX_DETAIL_CHARS: usize = 512;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ---------- 更新目录 ----------

/// `<主>.<次>.<修订>`（每段 1～9 位数字），可带 `-<预发布>`（字母数字与点，1～32 字）。
/// 与宿主拉起 setup 前的复核（`host/src/update.rs`）同一规则。
pub fn version_valid(version: &str) -> bool {
    let (core, pre) = match version.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (version, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty() && part.len() <= 9 && part.bytes().all(|b| b.is_ascii_digit())
        })
        && pre.is_none_or(|pre| {
            !pre.is_empty()
                && pre.len() <= 32
                && pre.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.')
        })
}

/// `atm-<v>-win-x64.json` → `(v, true)`；`.zip` → `(v, false)`。
fn feed_name(name: &str) -> Option<(&str, bool)> {
    let rest = name.strip_prefix("atm-")?;
    let (version, manifest) = if let Some(v) = rest.strip_suffix("-win-x64.json") {
        (v, true)
    } else {
        (rest.strip_suffix("-win-x64.zip")?, false)
    };
    version_valid(version).then_some((version, manifest))
}

/// Squirrel 时代投递的 RELEASES 与 nupkg：原生安装用不了，留着只占空间。
fn squirrel_name(name: &str) -> bool {
    if name == "RELEASES" {
        return true;
    }
    let Some(stem) = name.strip_suffix(".nupkg") else {
        return false;
    };
    let mut bytes = stem.bytes();
    bytes.next().is_some_and(|b| b.is_ascii_alphanumeric())
        && bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'+' | b'-'))
}

/// 2.0 `compareVersions`：逐段比数字（段里数字之后的部分不算），缺的段按 0。
pub fn compare_versions(left: &str, right: &str) -> Ordering {
    let parse = |v: &str| -> Vec<u64> {
        v.split('.')
            .map(|part| {
                let digits: String = part.chars().take_while(char::is_ascii_digit).collect();
                digits.parse().unwrap_or(0)
            })
            .collect()
    };
    let (a, b) = (parse(left), parse(right));
    for index in 0..a.len().max(b.len()) {
        let ordering = a
            .get(index)
            .copied()
            .unwrap_or(0)
            .cmp(&b.get(index).copied().unwrap_or(0));
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
    Ordering::Equal
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub version: String,
    pub manifest: PathBuf,
    pub package_bytes: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FeedScan {
    /// 比当前版本新、清单与包都完整的最高版本。
    pub candidate: Option<Candidate>,
    /// 最高的新版本清单不完整或与包对不上：`(版本, 原因)`。
    pub invalid: Option<(String, &'static str)>,
    /// 不高于当前版本的原生包与清单，以及 Squirrel 遗留物：可以清掉的文件名。
    pub consumed: Vec<String>,
}

fn read_manifest(path: &Path, version: &str) -> Result<Candidate, &'static str> {
    if std::fs::metadata(path).is_ok_and(|m| m.len() > MAX_MANIFEST_BYTES) {
        return Err("MANIFEST_TOO_LARGE");
    }
    let manifest: Value = match atm_install_state::read_json_limited(path, MAX_MANIFEST_BYTES) {
        Ok(Some(v)) => v,
        _ => return Err("MANIFEST_UNREADABLE"),
    };
    let package = format!("atm-{version}-win-x64.zip");
    let declared = manifest.get("packageBytes").and_then(Value::as_f64);
    if manifest.get("format").and_then(Value::as_f64) != Some(1.0)
        || manifest.get("version").and_then(Value::as_str) != Some(version)
        || manifest.get("arch").and_then(Value::as_str) != Some("x64")
        || manifest.get("package").and_then(Value::as_str) != Some(package.as_str())
        || declared.is_none()
        || !manifest.get("packageSha256").is_some_and(Value::is_string)
    {
        return Err("MANIFEST_INVALID");
    }
    let Some(dir) = path.parent() else {
        return Err("PACKAGE_MISSING");
    };
    let size = match std::fs::metadata(dir.join(&package)) {
        Ok(m) if m.is_file() => m.len(),
        _ => return Err("PACKAGE_MISSING"),
    };
    // 逐字节哈希留给 setup 的 STAGE（它反正要做）；这里只拦「包没写完 / 写错」这种明显的坏投递。
    if declared != Some(size as f64) {
        return Err("PACKAGE_SIZE_MISMATCH");
    }
    Ok(Candidate {
        version: version.to_owned(),
        manifest: path.to_path_buf(),
        package_bytes: size,
    })
}

/// 读一遍更新目录。只看单层的普通文件，名字不合模式的一律不碰。
pub fn scan_feed(feed: &Path, current: &str) -> FeedScan {
    let Ok(entries) = std::fs::read_dir(feed) else {
        return FeedScan::default();
    };
    let mut consumed = Vec::new();
    let mut newer: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if squirrel_name(&name) {
            consumed.push(name);
            continue;
        }
        let Some((version, manifest)) = feed_name(&name) else {
            continue;
        };
        if compare_versions(version, current) != Ordering::Greater {
            consumed.push(name);
        } else if manifest {
            newer.push(version.to_owned());
        }
    }
    consumed.sort();
    newer.sort_by(|a, b| compare_versions(a, b));
    let Some(highest) = newer.pop() else {
        return FeedScan {
            consumed,
            ..FeedScan::default()
        };
    };
    match read_manifest(&feed.join(format!("atm-{highest}-win-x64.json")), &highest) {
        Ok(candidate) => FeedScan {
            candidate: Some(candidate),
            invalid: None,
            consumed,
        },
        Err(reason) => FeedScan {
            candidate: None,
            invalid: Some((highest, reason)),
            consumed,
        },
    }
}

/// 删掉已消费的文件。名字来自 read_dir 且已按模式过滤；删不掉就留着，清理失败不算更新失败。
pub fn prune_feed(feed: &Path, names: &[String]) -> Vec<String> {
    names
        .iter()
        .filter(|name| {
            Path::new(name.as_str()).file_name() == Some(std::ffi::OsStr::new(name.as_str()))
        })
        .filter(|name| std::fs::remove_file(feed.join(name.as_str())).is_ok())
        .cloned()
        .collect()
}

/// 安装布局：`<root>\app.json` 与 `<root>\app-<v>\`（exe 所在目录）。便携版与源码运行是 `None`。
pub fn install_root_of(app_dir: &Path) -> Option<PathBuf> {
    let name = app_dir.file_name()?.to_str()?;
    let digit = name.strip_prefix("app-")?.bytes().next()?;
    if !digit.is_ascii_digit() {
        return None;
    }
    let root = app_dir.parent()?;
    root.join(atm_install_state::APP_POINTER)
        .is_file()
        .then(|| root.to_path_buf())
}

// ---------- 诊断 ----------

/// 2.0 `UpdateStatus`，界面直接展示。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateStatus {
    pub phase: String,
    pub outcome: String,
    pub code: String,
    pub message: String,
    pub action: String,
    pub at: String,
    pub version: Option<String>,
}

fn action_for(code: &str) -> &'static str {
    match code {
        "CHECK_FAILED" => "请检查本地更新目录中的安装包清单（atm-*.json）与安装包是否完整。",
        "DOWNLOAD_FAILED" => "请确认更新包仍在本地更新目录中，并稍后重试。",
        "VERIFY_FAILED" => "更新包不完整，请重新生成并投递完整安装包。",
        "INSTALL_FAILED" => {
            "更新没有装上，当前版本仍可使用；安装日志在安装目录的 state\\setup.log。"
        }
        "UPDATE_SOURCE_MISSING" => "当前没有待安装的本地更新，无需处理。",
        "UPDATE_SOURCE_CONSUMED" => "本地更新已经装好，旧安装包已清理。",
        "UPDATE_RUNNER_MISSING" => "找不到安装程序，请运行开始菜单里的「ATM 修复」。",
        "UPDATE_UNSUPPORTED" => "便携版与源码运行不参与自动更新。",
        "CHECKING" => "正在检查本地更新。",
        "UPDATE_AVAILABLE" => "已发现新版本，正在下载并校验。",
        "UP_TO_DATE" => "当前已是最新版本。",
        "UPDATE_READY" => "新版本已就绪，点击「立即更新」重启生效。",
        "INSTALLING" => "正在安装更新，完成后会自动重新打开。",
        "UPDATE_INSTALLED" => "已更新到最新版本。",
        _ => "当前版本仍可使用；请打开更新日志排查后重试。",
    }
}

fn redact_assignment(token: &str) -> Option<String> {
    let lower = token.to_ascii_lowercase();
    for key in [
        "access_token",
        "access-token",
        "accesstoken",
        "api_key",
        "api-key",
        "apikey",
        "token",
        "signature",
        "auth",
        "key",
    ] {
        for sep in ['=', ':'] {
            if let Some(at) = lower.find(&format!("{key}{sep}")) {
                // 键前面只能是开头或 URL 的 `?` / `&`，免得把 `monkey=` 这类当成 `key=`。
                let before = lower[..at].chars().last();
                if at == 0 || matches!(before, Some('?' | '&')) {
                    let cut = at + key.len() + 1;
                    return Some(format!("{}<redacted>", &token[..cut]));
                }
            }
        }
    }
    None
}

fn is_local_path(token: &str) -> bool {
    let t = token
        .trim_start_matches(['"', '\'', '('])
        .trim_start_matches("file:///");
    let b = t.as_bytes();
    (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/'))
        || t.starts_with("\\\\")
}

/// 2.0 `sanitizeUpdateDetail`：空白归一，令牌（Authorization / Bearer / token= 一类）与本机路径换成占位，
/// 最长 512 字。
pub fn sanitize_detail(detail: &str) -> String {
    // 下一个词要换成占位：`Bearer <x>`；`Authorization: [Bearer] <x>` 整段只留一个占位。
    #[derive(PartialEq)]
    enum Next {
        Plain,
        Secret,
        AfterAuthorization,
    }
    let mut out: Vec<String> = Vec::new();
    let mut next = Next::Plain;
    for token in detail.split_whitespace() {
        let lower = token.to_ascii_lowercase();
        if next == Next::AfterAuthorization && lower == "bearer" {
            next = Next::Secret;
            continue;
        }
        if next != Next::Plain {
            out.push("<redacted>".into());
            next = Next::Plain;
            continue;
        }
        if lower == "bearer" {
            out.push(token.to_owned());
            next = Next::Secret;
        } else if lower == "authorization:" {
            out.push("Authorization:".into());
            next = Next::AfterAuthorization;
        } else if is_local_path(token) {
            out.push("<local-path>".into());
        } else if let Some(redacted) = redact_assignment(token) {
            out.push(redacted);
        } else {
            out.push(token.to_owned());
        }
    }
    let joined = out.join(" ");
    if joined.chars().count() <= MAX_DETAIL_CHARS {
        return joined;
    }
    let mut cut: String = joined.chars().take(MAX_DETAIL_CHARS - 1).collect();
    cut.push('…');
    cut
}

/// 时钟（毫秒）。测试换成固定值。
pub type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

fn system_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

struct Diagnostics {
    logs: PathBuf,
    now: Clock,
}

impl Diagnostics {
    fn status_path(&self) -> PathBuf {
        self.logs.join("update-status.json")
    }

    fn rotate_for(&self, bytes: u64) {
        let log = self.logs.join("updater.ndjson");
        let Ok(meta) = std::fs::metadata(&log) else {
            return;
        };
        if meta.len() + bytes <= LOG_BYTES {
            return;
        }
        for index in (1..LOG_FILES).rev() {
            let target = self.logs.join(format!("updater.{index}.ndjson"));
            let source = if index == 1 {
                log.clone()
            } else {
                self.logs.join(format!("updater.{}.ndjson", index - 1))
            };
            let _ = std::fs::remove_file(&target);
            if source.exists() {
                let _ = std::fs::rename(&source, &target);
            }
        }
    }

    fn record(
        &self,
        phase: &str,
        outcome: &str,
        code: &str,
        detail: &str,
        version: Option<&str>,
    ) -> UpdateStatus {
        let message = sanitize_detail(detail);
        let status = UpdateStatus {
            phase: phase.into(),
            outcome: outcome.into(),
            code: code.into(),
            message: if message.is_empty() {
                code.into()
            } else {
                message
            },
            action: action_for(code).into(),
            at: atm_install_state::startup::iso_utc((self.now)()),
            version: version.map(str::to_owned),
        };
        // 诊断写不进去不能阻断更新本身：返回值照样给当前调用者展示。
        let _ = (|| -> std::io::Result<()> {
            use std::io::Write;
            std::fs::create_dir_all(&self.logs)?;
            let line = format!("{}\n", serde_json::to_string(&status)?);
            self.rotate_for(line.len() as u64);
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.logs.join("updater.ndjson"))?
                .write_all(line.as_bytes())?;
            atm_install_state::durable::write_atomic(
                &self.status_path(),
                serde_json::to_string(&status)?.as_bytes(),
            )
        })();
        status
    }

    fn read(&self) -> Option<UpdateStatus> {
        atm_install_state::read_json_limited::<UpdateStatus>(&self.status_path(), MAX_STATUS_BYTES)
            .ok()
            .flatten()
    }
}

// ---------- 协调器 ----------

/// 待安装版本变了（`None` 是没有了）：宿主刷托盘，有了新版本时按通知方式提示。
pub type PendingSink = Arc<dyn Fn(Option<String>) + Send + Sync>;

pub struct Options {
    /// 3.0 根 `N`：更新目录 `N\updates`，诊断 `N\logs`。
    pub data_dir: PathBuf,
    pub current_version: String,
    /// 安装根（含 app.json 的那一层）；便携版与源码运行为 `None`，不参与更新。
    pub install_root: Option<PathBuf>,
    pub on_pending: PendingSink,
    pub now: Option<Clock>,
}

/// 「立即更新」的结果：有包时 `manifest` 是要交给 setup 的清单，状态已经记成 INSTALLING。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Applied {
    pub status: Option<UpdateStatus>,
    pub manifest: Option<PathBuf>,
}

#[derive(Default)]
struct Timer {
    /// 上次发起的安装还没落定：到点复查一次。
    settle_at: Option<Instant>,
    stopped: bool,
}

pub struct Coordinator {
    feed: PathBuf,
    current: String,
    install_root: Option<PathBuf>,
    diagnostics: Diagnostics,
    on_pending: PendingSink,
    ready: Mutex<Option<Candidate>>,
    /// 同一时刻只跑一次检查。
    checking: Mutex<()>,
    timer: Mutex<Timer>,
    timer_changed: Condvar,
    settle_after: Mutex<Duration>,
}

enum Previous {
    None,
    Pending,
    Reported(UpdateStatus),
}

impl Coordinator {
    pub fn new(o: Options) -> Coordinator {
        Coordinator {
            feed: o.data_dir.join("updates"),
            current: o.current_version,
            install_root: o.install_root,
            diagnostics: Diagnostics {
                logs: o.data_dir.join("logs"),
                now: o.now.unwrap_or_else(|| Arc::new(system_ms)),
            },
            on_pending: o.on_pending,
            ready: Mutex::new(None),
            checking: Mutex::new(()),
            timer: Mutex::new(Timer::default()),
            timer_changed: Condvar::new(),
            settle_after: Mutex::new(SETTLE_RECHECK),
        }
    }

    /// 测试用：换掉落定复查的间隔。
    #[doc(hidden)]
    pub fn with_settle_recheck(self, after: Duration) -> Coordinator {
        *lock(&self.settle_after) = after;
        self
    }

    /// 托盘上「x 已就绪」的版本。
    pub fn pending(&self) -> Option<String> {
        lock(&self.ready).as_ref().map(|c| c.version.clone())
    }

    /// 最后一次的状态（界面的「更新」卡片）。
    pub fn status(&self, principal: &Principal) -> Result<Option<UpdateStatus>, DomainError> {
        capability::require(principal, Capability::UpdateStatus)?;
        Ok(self.diagnostics.read())
    }

    /// 检查一次（周期任务或用户手点）。撞上正在跑的检查就等它，拿它的结果。
    pub fn check(&self, principal: &Principal) -> Result<Option<UpdateStatus>, DomainError> {
        capability::require(principal, Capability::UpdateCheck)?;
        Ok(self.checked())
    }

    /// 用户点了「立即更新」：先重新确认包还在且完整，有包就记 INSTALLING，把清单交给宿主拉起 setup。
    pub fn apply(&self, principal: &Principal) -> Result<Applied, DomainError> {
        capability::require(principal, Capability::UpdateApply)?;
        self.checked();
        let Some(candidate) = lock(&self.ready).clone() else {
            return Ok(Applied {
                status: self.diagnostics.read(),
                manifest: None,
            });
        };
        let status = self.diagnostics.record(
            "INSTALL",
            "IN_PROGRESS",
            "INSTALLING",
            &format!("正在安装 {}，完成后会自动重新打开", candidate.version),
            Some(&candidate.version),
        );
        Ok(Applied {
            status: Some(status),
            manifest: Some(candidate.manifest),
        })
    }

    /// 宿主拒绝或没能拉起 setup。
    pub fn launch_failed(&self) -> UpdateStatus {
        let version = self.pending();
        self.diagnostics.record(
            "INSTALL",
            "ERROR",
            "INSTALL_FAILED",
            "安装程序没有启动",
            version.as_deref(),
        )
    }

    fn checked(&self) -> Option<UpdateStatus> {
        match self.checking.try_lock() {
            Ok(_guard) => self.run_check(),
            Err(std::sync::TryLockError::Poisoned(p)) => {
                let _guard = p.into_inner();
                self.run_check()
            }
            Err(std::sync::TryLockError::WouldBlock) => {
                // 前一次检查跑完就是这次的结果。
                drop(lock(&self.checking));
                self.diagnostics.read()
            }
        }
    }

    fn set_ready(&self, candidate: Option<Candidate>) {
        let changed = {
            let mut ready = lock(&self.ready);
            let changed =
                ready.as_ref().map(|c| &c.version) != candidate.as_ref().map(|c| &c.version);
            *ready = candidate;
            changed.then(|| ready.as_ref().map(|c| c.version.clone()))
        };
        if let Some(pending) = changed {
            (self.on_pending)(pending);
        }
    }

    fn run_check(&self) -> Option<UpdateStatus> {
        if self.install_root.is_none() {
            self.set_ready(None);
            return Some(self.diagnostics.record(
                "CHECK",
                "SKIPPED",
                "UPDATE_UNSUPPORTED",
                "便携版与源码运行不参与自动更新",
                None,
            ));
        }
        let previous = match self.last_install() {
            Previous::Pending => {
                // 结果未定：不报、不清。这时清掉包，万一事务随后回滚，用户就没有包可以重试了。
                let after = *lock(&self.settle_after);
                let mut timer = lock(&self.timer);
                if timer.settle_at.is_none() {
                    timer.settle_at = Some(Instant::now() + after);
                    self.timer_changed.notify_all();
                }
                return self.diagnostics.read();
            }
            Previous::Reported(status) => Some(status),
            Previous::None => None,
        };
        let scan = scan_feed(&self.feed, &self.current);
        let removed = prune_feed(&self.feed, &scan.consumed);
        if let Some((version, reason)) = scan.invalid {
            self.set_ready(None);
            return Some(self.diagnostics.record(
                "VERIFY",
                "ERROR",
                "VERIFY_FAILED",
                &format!("{version} 的安装包不完整（{reason}）"),
                Some(&version),
            ));
        }
        if let Some(candidate) = scan.candidate {
            let version = candidate.version.clone();
            let status = self.diagnostics.record(
                "READY",
                "SUCCESS",
                "UPDATE_READY",
                &format!("{version} 已就绪，点击「立即更新」重启生效"),
                Some(&version),
            );
            self.set_ready(Some(candidate));
            return Some(status);
        }
        self.set_ready(None);
        // 刚装完的那次检查：保留「已更新到 x」，不要立刻被「没有更新」盖掉。
        if previous.is_some() {
            return previous;
        }
        if !removed.is_empty() {
            return Some(self.diagnostics.record(
                "CHECK",
                "SKIPPED",
                "UPDATE_SOURCE_CONSUMED",
                &format!("本地更新已安装完毕，已清理 {} 个文件", removed.len()),
                None,
            ));
        }
        Some(self.diagnostics.record(
            "CHECK",
            "SKIPPED",
            "UPDATE_SOURCE_MISSING",
            "当前没有待安装的本地更新",
            None,
        ))
    }

    /// 上一次是我们发起的安装（状态停在 INSTALLING），结果在安装根的事务日志里：
    /// 成功则本进程就是新版本；没成则 setup 已把旧版本拉回来，这里把原因记下。
    fn last_install(&self) -> Previous {
        let (Some(last), Some(root)) = (self.diagnostics.read(), &self.install_root) else {
            return Previous::None;
        };
        if last.code != "INSTALLING" {
            return Previous::None;
        }
        let journal: Option<Value> = atm_install_state::read_json_limited(
            &root
                .join(atm_install_state::STATE_DIR)
                .join(atm_install_state::JOURNAL),
            MAX_JOURNAL_BYTES,
        )
        .ok()
        .flatten();
        let Some(journal) = journal else {
            return Previous::None;
        };
        let to = journal.get("to").and_then(Value::as_str);
        let Some(outcome) = journal.get("outcome").and_then(Value::as_str) else {
            return Previous::Pending;
        };
        if outcome == "COMMITTED" && to == Some(self.current.as_str()) {
            return Previous::Reported(self.diagnostics.record(
                "READY",
                "SUCCESS",
                "UPDATE_INSTALLED",
                &format!("已更新到 {}", self.current),
                Some(&self.current),
            ));
        }
        if to.is_some() && to == last.version.as_deref() {
            let target = last.version.clone().unwrap_or_default();
            // outcome 来自安装根的事务日志：只收大写的枚举名，别的字一律不进诊断。
            let outcome = if outcome.bytes().all(|b| b.is_ascii_uppercase() || b == b'_')
                && outcome.len() <= 40
            {
                outcome
            } else {
                "UNKNOWN"
            };
            return Previous::Reported(self.diagnostics.record(
                "INSTALL",
                "ERROR",
                "INSTALL_FAILED",
                &format!("{target} 没有装上（{outcome}），当前仍是 {}", self.current),
                Some(&target),
            ));
        }
        Previous::None
    }
}

/// 周期检查（job `update.check`）：启动时一次，之后每 `every` 一次；安装没落定时到点复查。
pub struct Schedule {
    coordinator: Arc<Coordinator>,
    thread: JoinHandle<()>,
}

impl Schedule {
    pub fn start(coordinator: Arc<Coordinator>, every: Duration) -> Schedule {
        let thread = {
            let coordinator = coordinator.clone();
            std::thread::Builder::new()
                .name("atm-update".into())
                .spawn(move || {
                    let principal = Principal::system_job(JobId::UpdateCheck);
                    loop {
                        let _ = coordinator.check(&principal);
                        let next = Instant::now() + every;
                        let mut timer = lock(&coordinator.timer);
                        loop {
                            if timer.stopped {
                                return;
                            }
                            let due = timer.settle_at.map_or(next, |s| s.min(next));
                            let now = Instant::now();
                            if now >= due {
                                timer.settle_at = None;
                                break;
                            }
                            timer = coordinator
                                .timer_changed
                                .wait_timeout(timer, due - now)
                                .unwrap_or_else(|e| e.into_inner())
                                .0;
                        }
                    }
                })
                .expect("spawn the update thread")
        };
        Schedule {
            coordinator,
            thread,
        }
    }

    /// 停下并等线程结束。
    pub fn stop(self) {
        lock(&self.coordinator.timer).stopped = true;
        self.coordinator.timer_changed.notify_all();
        let _ = self.thread.join();
    }
}

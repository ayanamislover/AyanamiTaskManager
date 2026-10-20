//! ATM 的 Skills（2.0 `agent-config/src/agent-skills.ts`）：`atm-plan`、`atm-task`、`atm-knowledge` 与共享资源 `_shared`，
//! 从 `<L>\skills` 复制进各客户端的 skills 根。
//!
//! 3.0 的变化只在备份与暂存的位置：2.0 把 `atm-plan.bak-…` 和 `.atm-plan.tmp-…` 留在 skills 根里，Agent 会把它们当成
//! 又一个 Skill 加载（同名 frontmatter，旧正文）。3.0 放进旁边的 [`BACKUP_DIR`]，每个 Skill 只留最近
//! [`crate::files::BACKUP_RETENTION`] 份；[`migrate_legacy_backups`] 把 2.0 留下的挪过去。
//! 安装基线 `.atm-skills.json` 与指纹算法不变，2.0 装进去的 Skill 在 3.0 里认得出「没被改过」。

use crate::files::{BACKUP_RETENTION, copy_dir, directory_fingerprint, js_json, random_hex, stamp};
use crate::rules::State;
use crate::{AgentError, Result};
use serde_json::{Map, Value, json};
use std::fs;
use std::path::{Path, PathBuf};

pub const SKILL_NAMES: [&str; 3] = ["atm-plan", "atm-task", "atm-knowledge"];
pub const RESOURCE_DIRS: [&str; 1] = ["_shared"];
pub const BASELINE: &str = ".atm-skills.json";
pub const BACKUP_DIR: &str = ".atm-skill-backups";

fn all_names() -> impl Iterator<Item = &'static str> {
    SKILL_NAMES.into_iter().chain(RESOURCE_DIRS)
}

/// `<skills 根>` 旁边的备份目录（`~/.codex/skills` → `~/.codex/.atm-skill-backups`）。
pub fn backup_root(target_root: &Path) -> PathBuf {
    target_root
        .parent()
        .map_or_else(|| target_root.join(BACKUP_DIR), |p| p.join(BACKUP_DIR))
}

fn io(code: &str) -> impl Fn(std::io::Error) -> AgentError + '_ {
    move |e| AgentError::io(code, e)
}

fn read_baseline(target_root: &Path) -> Map<String, Value> {
    fs::read_to_string(target_root.join(BASELINE))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.as_object().cloned())
        .map(|m| m.into_iter().filter(|(_, v)| v.is_string()).collect())
        .unwrap_or_default()
}

fn write_baseline(target_root: &Path, entries: &Map<String, Value>) {
    // 写不进去只会让下次不自动更新（2.0 同），不算安装失败。
    let _ = fs::write(
        target_root.join(BASELINE),
        js_json(&Value::Object(entries.clone())),
    );
}

fn backup_path(target_root: &Path, name: &str) -> PathBuf {
    backup_root(target_root).join(format!("{name}.bak-{}-{}", stamp(), random_hex(3)))
}

/// 每个名字只留最近几份备份。
fn prune(target_root: &Path, name: &str) {
    let dir = backup_root(target_root);
    let prefix = format!("{name}.bak-");
    let Ok(it) = fs::read_dir(&dir) else { return };
    let mut names: Vec<String> = it
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with(&prefix))
        .collect();
    names.sort();
    names.reverse();
    for stale in names.into_iter().skip(BACKUP_RETENTION) {
        let _ = remove_tree(&dir.join(stale));
    }
}

/// 删一个目录树；碰到链接只删链接本身，不进去。
pub fn remove_tree(path: &Path) -> std::io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() || crate::files::is_reparse_point(&meta) {
        return if meta.is_dir() {
            fs::remove_dir(path)
        } else {
            fs::remove_file(path)
        };
    }
    if meta.is_dir() {
        for e in fs::read_dir(path)? {
            remove_tree(&e?.path())?;
        }
        fs::remove_dir(path)
    } else {
        fs::remove_file(path)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Installed {
    pub skills: Vec<String>,
    pub paths: Vec<PathBuf>,
    pub backups: Vec<PathBuf>,
}

/// 装 `names`（`None` 是全部）。每个先复制到备份目录里的暂存处，旧的挪进备份目录，再把暂存改名就位；
/// 就位失败放回旧的。
pub fn install(
    source_root: &Path,
    target_root: &Path,
    names: Option<&[String]>,
) -> Result<Installed> {
    let wanted: Vec<String> = match names {
        Some(n) => n.to_vec(),
        None => all_names().map(str::to_string).collect(),
    };
    let mut out = Installed::default();
    if wanted.is_empty() {
        return Ok(out);
    }
    fs::create_dir_all(target_root).map_err(io("AGENT_SKILL_WRITE_FAILED"))?;
    let backups = backup_root(target_root);
    fs::create_dir_all(&backups).map_err(io("AGENT_SKILL_WRITE_FAILED"))?;
    for name in &wanted {
        let source = source_root.join(name);
        let target = target_root.join(name);
        if !source.is_dir() || (name != "_shared" && !source.join("SKILL.md").is_file()) {
            return Err(AgentError::new(
                "AGENT_SKILL_MISSING",
                format!("AGENT_SKILL_MISSING: {name}"),
            ));
        }
        let staging = backups.join(format!(
            ".{name}.tmp-{}-{}",
            std::process::id(),
            random_hex(4)
        ));
        if let Err(e) = copy_dir(&source, &staging) {
            let _ = remove_tree(&staging);
            return Err(AgentError::io("AGENT_SKILL_WRITE_FAILED", e));
        }
        let mut backup = None;
        let placed = (|| -> std::io::Result<()> {
            if fs::symlink_metadata(&target).is_ok() {
                let b = backup_path(target_root, name);
                fs::rename(&target, &b)?;
                backup = Some(b);
            }
            fs::rename(&staging, &target)
        })();
        if let Err(e) = placed {
            let _ = remove_tree(&staging);
            if let Some(b) = &backup
                && !target.exists()
                && b.exists()
            {
                let _ = fs::rename(b, &target);
            }
            return Err(AgentError::io("AGENT_SKILL_WRITE_FAILED", e));
        }
        if let Some(b) = backup {
            out.backups.push(b);
        }
        prune(target_root, name);
        out.paths.push(target);
    }
    let mut baseline = read_baseline(target_root);
    for name in &wanted {
        if let Ok(Some(fp)) = directory_fingerprint(&target_root.join(name)) {
            baseline.insert(name.clone(), json!(fp));
        }
    }
    write_baseline(target_root, &baseline);
    out.skills = SKILL_NAMES
        .iter()
        .filter(|n| wanted.iter().any(|w| w == *n))
        .map(|n| n.to_string())
        .collect();
    Ok(out)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Skill {
    pub name: String,
    pub state: State,
    pub version: Option<u32>,
    pub matches_install_baseline: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Inspection {
    pub state: State,
    pub skills: Vec<Skill>,
}

impl Inspection {
    pub fn view(&self) -> Value {
        json!({
            "state": self.state.as_str(),
            "skills": self.skills.iter().map(|s| json!({
                "name": s.name,
                "state": s.state.as_str(),
                "version": s.version,
                "matchesInstallBaseline": s.matches_install_baseline,
            })).collect::<Vec<_>>(),
        })
    }
}

fn skill_version(dir: &Path) -> Option<u32> {
    let text = fs::read_to_string(dir.join("SKILL.md")).ok()?;
    let at = text.find("atm-integration-version:")?;
    let rest = text[at + "atm-integration-version:".len()..].trim_start();
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

fn fingerprint(p: &Path) -> Option<String> {
    directory_fingerprint(p).ok().flatten()
}

pub fn inspect(source_root: &Path, target_root: &Path) -> Inspection {
    let baseline = read_baseline(target_root);
    let skills: Vec<Skill> = SKILL_NAMES
        .iter()
        .map(|name| {
            let source = source_root.join(name);
            let target = target_root.join(name);
            if !target.exists() {
                return Skill {
                    name: name.to_string(),
                    state: State::NotInstalled,
                    version: None,
                    matches_install_baseline: false,
                };
            }
            let fp = fingerprint(&target);
            let matches =
                fp.is_some() && baseline.get(*name).and_then(Value::as_str) == fp.as_deref();
            let target_version = skill_version(&target);
            let state = if skill_version(&source) != target_version {
                State::NeedsUpdate
            } else if fingerprint(&source) == fp {
                State::Installed
            } else {
                State::Modified
            };
            Skill {
                name: name.to_string(),
                state,
                version: target_version,
                matches_install_baseline: matches,
            }
        })
        .collect();
    let shared_target = target_root.join("_shared");
    let shared = if !shared_target.exists() {
        State::NotInstalled
    } else if fingerprint(&source_root.join("_shared")) == fingerprint(&shared_target) {
        State::Installed
    } else {
        State::Modified
    };
    let states: Vec<State> = skills.iter().map(|s| s.state).chain([shared]).collect();
    let state = if states.contains(&State::Modified) {
        State::Modified
    } else if states.contains(&State::NeedsUpdate) {
        State::NeedsUpdate
    } else if states.iter().all(|s| *s == State::Installed) {
        State::Installed
    } else {
        State::NotInstalled
    };
    Inspection { state, skills }
}

/// 无人值守时该补的（2.0 `agentSkillsToRepair`）：没装的、版本旧且仍是 ATM 上次写进去那样的；`_shared` 缺了单独补。
pub fn to_repair(source_root: &Path, target_root: &Path) -> Vec<String> {
    let mut names: Vec<String> = inspect(source_root, target_root)
        .skills
        .into_iter()
        .filter(|s| {
            s.state == State::NotInstalled
                || (s.state == State::NeedsUpdate && s.matches_install_baseline)
        })
        .map(|s| s.name)
        .collect();
    for shared in RESOURCE_DIRS {
        if !target_root.join(shared).exists() {
            names.push(shared.to_string());
        }
    }
    names
}

pub fn uninstall(target_root: &Path) -> Result<Vec<PathBuf>> {
    let mut backups = Vec::new();
    for name in all_names() {
        let target = target_root.join(name);
        if fs::symlink_metadata(&target).is_err() {
            continue;
        }
        fs::create_dir_all(backup_root(target_root)).map_err(io("AGENT_SKILL_WRITE_FAILED"))?;
        let b = backup_path(target_root, name);
        fs::rename(&target, &b).map_err(io("AGENT_SKILL_WRITE_FAILED"))?;
        prune(target_root, name);
        backups.push(b);
    }
    let _ = fs::remove_file(target_root.join(BASELINE));
    Ok(backups)
}

/// 把 2.0 留在 skills 根里的 `atm-*.bak-*` / `_shared.bak-*` 备份和 `.atm-*.tmp-*` 暂存挪进备份目录（暂存直接删）。
/// 只认 ATM 自己的名字；返回挪走的个数。幂等：第二次什么也找不到。
pub fn migrate_legacy_backups(target_root: &Path) -> Result<usize> {
    let Ok(it) = fs::read_dir(target_root) else {
        return Ok(0);
    };
    let mut moved = 0;
    let entries: Vec<_> = it.flatten().collect();
    for e in entries {
        let file = e.file_name().to_string_lossy().into_owned();
        let owner = all_names().find(|n| {
            file.starts_with(&format!("{n}.bak-")) || file.starts_with(&format!(".{n}.tmp-"))
        });
        let Some(owner) = owner else { continue };
        let path = e.path();
        if file.starts_with('.') {
            remove_tree(&path).map_err(io("AGENT_SKILL_WRITE_FAILED"))?;
            moved += 1;
            continue;
        }
        let dir = backup_root(target_root);
        fs::create_dir_all(&dir).map_err(io("AGENT_SKILL_WRITE_FAILED"))?;
        let mut to = dir.join(&file);
        if to.exists() {
            to = dir.join(format!("{file}-{}", random_hex(3)));
        }
        fs::rename(&path, &to).map_err(io("AGENT_SKILL_WRITE_FAILED"))?;
        prune(target_root, owner);
        moved += 1;
    }
    Ok(moved)
}

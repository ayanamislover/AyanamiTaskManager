//! Agent 文档的安装（2.0 `agent-documentation.ts` 与 `agent-documentation-manifest.ts`）：把安装包里的
//! `ATM_AGENT_GUIDE.md`、`docs\`、`integrations\skills\` 换进 `L`（`%LOCALAPPDATA%\AyanamiTaskManager`）的
//! `ATM_AGENT_GUIDE.md`、`docs\`、`skills\`。
//!
//! 一次三件一起换：先全部复制到 `<名>.staging-<16hex>` 并按清单核对，旧的改名为 `<名>.backup-<16hex>`，暂存改名就位，
//! 再核对一次；任一步失败按逆序放回。成功后备份先改名为 `.backup-committed-` 再删，删不掉的下次启动再收。上次中断
//! 留下的 `.backup-` 说明回滚没做完，开头先把它放回去。所有改名与删除都限定在 `L` 下这几个名字，名字对不上就拒绝。
//!
//! 3.0 多一条：已装的与安装包逐文件一致时什么也不动（2.0 每次启动都换一遍）。

use crate::files::random_hex;
use crate::{AgentError, Result};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub const GUIDE: &str = "ATM_AGENT_GUIDE.md";
const MAX_RETRY: u32 = 4;
const RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(25);
const MAX_STALE: usize = 64;

/// 相对路径（`/` 分隔，带 `docs/`、`skills/` 前缀）→（字节数，sha256）。
pub type Manifest = BTreeMap<String, (u64, String)>;

fn err(code: &str, detail: impl std::fmt::Display) -> AgentError {
    AgentError::new(code, format!("{code}: {detail}"))
}

fn is_link(meta: &fs::Metadata) -> bool {
    meta.file_type().is_symlink() || crate::files::is_reparse_point(meta)
}

fn exists(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok()
}

fn collect(root: &Path, dir: &Path, prefix: &str, out: &mut Manifest) -> Result<()> {
    let it = fs::read_dir(dir).map_err(|e| err("AGENT_DOCUMENTATION_READ_FAILED", e))?;
    for e in it {
        let e = e.map_err(|e| err("AGENT_DOCUMENTATION_READ_FAILED", e))?;
        let path = e.path();
        let meta =
            fs::symlink_metadata(&path).map_err(|e| err("AGENT_DOCUMENTATION_READ_FAILED", e))?;
        if is_link(&meta) {
            return Err(err(
                "AGENT_DOCUMENTATION_SYMLINK_UNSUPPORTED",
                path.display(),
            ));
        }
        let name = e.file_name().to_string_lossy().into_owned();
        let rel = format!("{prefix}/{name}");
        if meta.is_dir() {
            collect(root, &path, &rel, out)?;
        } else if meta.is_file() {
            out.insert(rel, hash_file(&path)?);
        } else {
            return Err(err("AGENT_DOCUMENTATION_ENTRY_UNSUPPORTED", path.display()));
        }
    }
    let _ = root;
    Ok(())
}

fn hash_file(p: &Path) -> Result<(u64, String)> {
    let bytes = fs::read(p).map_err(|e| err("AGENT_DOCUMENTATION_READ_FAILED", e))?;
    Ok((
        bytes.len() as u64,
        crate::files::hex(&Sha256::digest(&bytes)),
    ))
}

fn require(p: &Path, label: &str, dir: bool) -> Result<()> {
    let meta =
        fs::symlink_metadata(p).map_err(|_| err(&format!("{label}_MISSING"), p.display()))?;
    if is_link(&meta) || meta.is_dir() != dir || (!dir && !meta.is_file()) {
        return Err(err(&format!("{label}_INVALID"), p.display()));
    }
    Ok(())
}

pub fn manifest_of(guide: &Path, docs: &Path, skills: &Path) -> Result<Manifest> {
    require(guide, "AGENT_GUIDE", false)?;
    require(docs, "AGENT_DOCS", true)?;
    require(skills, "AGENT_SKILLS", true)?;
    let mut m = Manifest::new();
    m.insert(GUIDE.into(), hash_file(guide)?);
    collect(docs, docs, "docs", &mut m)?;
    collect(skills, skills, "skills", &mut m)?;
    Ok(m)
}

/// 安装包里的那份（`integrations\skills`）。
pub fn bundled_manifest(bundled: &Path) -> Result<Manifest> {
    manifest_of(
        &bundled.join(GUIDE),
        &bundled.join("docs"),
        &bundled.join("integrations").join("skills"),
    )
}

pub fn installed_manifest(l: &Path) -> Result<Manifest> {
    manifest_of(&l.join(GUIDE), &l.join("docs"), &l.join("skills"))
}

fn assert_same(expected: &Manifest, actual: &Manifest) -> Result<()> {
    let mut mismatches = Vec::new();
    let keys: std::collections::BTreeSet<&String> = expected.keys().chain(actual.keys()).collect();
    for k in keys {
        match (expected.get(k), actual.get(k)) {
            (None, Some(_)) => mismatches.push(format!("extra:{k}")),
            (Some(_), None) => mismatches.push(format!("missing:{k}")),
            (Some(a), Some(b)) if a != b => mismatches.push(format!("content:{k}")),
            _ => {}
        }
    }
    if mismatches.is_empty() {
        return Ok(());
    }
    let more = if mismatches.len() > 8 {
        format!(",+{}", mismatches.len() - 8)
    } else {
        String::new()
    };
    Err(err(
        "AGENT_DOCUMENTATION_MANIFEST_MISMATCH",
        format!("{}{more}", mismatches[..mismatches.len().min(8)].join(",")),
    ))
}

const COMPONENTS: [&str; 3] = [GUIDE, "docs", "skills"];
const KINDS: [&str; 3] = ["staging", "backup", "backup-committed"];

/// `L` 下 ATM 自己的名字：三件本体，或 `<件>.<staging|backup|backup-committed>-<16hex>`。
fn owned(l: &Path, p: &Path, artifact_only: bool) -> Result<()> {
    if p.parent() != Some(l) {
        return Err(err(
            "AGENT_DOCUMENTATION_CLEANUP_OUTSIDE_DATA_DIR",
            p.display(),
        ));
    }
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if (!artifact_only && COMPONENTS.contains(&name.as_str())) || parse_artifact(&name).is_some() {
        return Ok(());
    }
    Err(err(
        "AGENT_DOCUMENTATION_CLEANUP_TARGET_INVALID",
        p.display(),
    ))
}

fn parse_artifact(name: &str) -> Option<(&'static str, &'static str, String)> {
    for c in COMPONENTS {
        let Some(rest) = name.strip_prefix(c).and_then(|r| r.strip_prefix('.')) else {
            continue;
        };
        // 先试长的（backup-committed 以 backup 开头）。
        for k in ["backup-committed", "staging", "backup"] {
            if let Some(nonce) = rest.strip_prefix(k).and_then(|r| r.strip_prefix('-'))
                && nonce.len() == 16
                && nonce
                    .bytes()
                    .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            {
                let kind = KINDS.iter().find(|x| **x == k).copied()?;
                return Some((c, kind, nonce.to_string()));
            }
        }
    }
    None
}

fn retry<T>(mut op: impl FnMut() -> io::Result<T>) -> io::Result<T> {
    let mut attempt = 1;
    loop {
        match op() {
            Ok(v) => return Ok(v),
            Err(e)
                if attempt < MAX_RETRY
                    && matches!(
                        e.kind(),
                        io::ErrorKind::PermissionDenied
                            | io::ErrorKind::DirectoryNotEmpty
                            | io::ErrorKind::ResourceBusy
                    ) =>
            {
                attempt += 1;
                std::thread::sleep(RETRY_DELAY);
            }
            Err(e) => return Err(e),
        }
    }
}

fn rename_owned(l: &Path, from: &Path, to: &Path) -> Result<()> {
    owned(l, from, false)?;
    owned(l, to, false)?;
    retry(|| fs::rename(from, to)).map_err(|e| err("AGENT_DOCUMENTATION_RENAME_FAILED", e))
}

fn remove_owned(l: &Path, p: &Path, artifact_only: bool) -> Result<()> {
    owned(l, p, artifact_only)?;
    retry(|| match crate::skills::remove_tree(p) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    })
    .map_err(|e| err("AGENT_DOCUMENTATION_REMOVE_FAILED", e))
}

fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    require(from, "AGENT_DOCUMENTATION_SOURCE", true)?;
    fs::create_dir_all(to).map_err(|e| err("AGENT_DOCUMENTATION_COPY_FAILED", e))?;
    for e in fs::read_dir(from).map_err(|e| err("AGENT_DOCUMENTATION_COPY_FAILED", e))? {
        let e = e.map_err(|e| err("AGENT_DOCUMENTATION_COPY_FAILED", e))?;
        let meta = fs::symlink_metadata(e.path())
            .map_err(|e| err("AGENT_DOCUMENTATION_COPY_FAILED", e))?;
        let target = to.join(e.file_name());
        if is_link(&meta) {
            return Err(err(
                "AGENT_DOCUMENTATION_SYMLINK_UNSUPPORTED",
                e.path().display(),
            ));
        } else if meta.is_dir() {
            copy_tree(&e.path(), &target)?;
        } else if meta.is_file() {
            fs::copy(e.path(), &target).map_err(|e| err("AGENT_DOCUMENTATION_COPY_FAILED", e))?;
        } else {
            return Err(err(
                "AGENT_DOCUMENTATION_ENTRY_UNSUPPORTED",
                e.path().display(),
            ));
        }
    }
    Ok(())
}

fn safe_tree(p: &Path) -> bool {
    let Ok(meta) = fs::symlink_metadata(p) else {
        return false;
    };
    if is_link(&meta) {
        return false;
    }
    if meta.is_file() {
        return true;
    }
    meta.is_dir() && fs::read_dir(p).is_ok_and(|it| it.flatten().all(|e| safe_tree(&e.path())))
}

fn live_ready(l: &Path, component: &str) -> bool {
    let p = l.join(component);
    let Ok(meta) = fs::symlink_metadata(&p) else {
        return false;
    };
    if is_link(&meta) {
        return false;
    }
    if component == GUIDE {
        meta.is_file()
    } else {
        meta.is_dir() && safe_tree(&p)
    }
}

/// 收拾上次留下的：`.backup-` 放回（回滚没做完）、`.backup-committed-` 删掉（本体不在时放回）、`.staging-` 删掉。
fn reconcile(l: &Path) {
    let Ok(it) = fs::read_dir(l) else { return };
    let mut found: Vec<(String, &'static str, &'static str, String)> = it
        .flatten()
        .filter_map(|e| {
            let n = e.file_name().to_string_lossy().into_owned();
            parse_artifact(&n).map(|(c, k, nonce)| (n, c, k, nonce))
        })
        .collect();
    found.sort();
    found.truncate(MAX_STALE);
    for (name, c, _, nonce) in found.iter().filter(|a| a.2 == "backup") {
        let path = l.join(name);
        if !safe_tree(&path) {
            continue;
        }
        let target = l.join(c);
        let stage = l.join(format!("{c}.staging-{nonce}"));
        let _ = (|| -> Result<()> {
            if exists(&target) {
                if exists(&stage) {
                    remove_owned(l, &stage, true)?;
                }
                rename_owned(l, &target, &stage)?;
            }
            rename_owned(l, &path, &target)?;
            if exists(&stage) {
                remove_owned(l, &stage, true)?;
            }
            Ok(())
        })();
    }
    for (name, c, _, _) in found.iter().filter(|a| a.2 == "backup-committed") {
        let path = l.join(name);
        let target = l.join(c);
        if !live_ready(l, c)
            && !exists(&target)
            && safe_tree(&path)
            && rename_owned(l, &path, &target).is_ok()
        {
            continue;
        }
        let _ = remove_owned(l, &path, true);
    }
    for (name, ..) in found.iter().filter(|a| a.2 == "staging") {
        let _ = remove_owned(l, &l.join(name), true);
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// 已装的与安装包一致，没动。
    Current,
    Installed,
}

struct Component {
    name: &'static str,
    target: PathBuf,
    stage: PathBuf,
    backup: PathBuf,
    committed: PathBuf,
}

/// 把 `bundled`（安装包的 `resources\agent`）装进 `l`。
pub fn install(bundled: &Path, l: &Path) -> Result<Outcome> {
    let expected = bundled_manifest(bundled)?;
    fs::create_dir_all(l).map_err(|e| err("AGENT_DATA_DIR_INVALID", e))?;
    require(l, "AGENT_DATA_DIR", true)?;
    reconcile(l);
    if installed_manifest(l).is_ok_and(|m| assert_same(&expected, &m).is_ok()) {
        return Ok(Outcome::Current);
    }
    let nonce = random_hex(8);
    let components: Vec<Component> = COMPONENTS
        .iter()
        .map(|c| Component {
            name: c,
            target: l.join(c),
            stage: l.join(format!("{c}.staging-{nonce}")),
            backup: l.join(format!("{c}.backup-{nonce}")),
            committed: l.join(format!("{c}.backup-committed-{nonce}")),
        })
        .collect();
    if components
        .iter()
        .any(|c| exists(&c.stage) || exists(&c.backup))
    {
        return Err(err(
            "AGENT_DOCUMENTATION_TRANSACTION_COLLISION",
            l.display(),
        ));
    }
    let mut moved: Vec<usize> = Vec::new();
    let mut placed: Vec<usize> = Vec::new();
    let attempt = (|| -> Result<()> {
        owned(l, &components[0].stage, true)?;
        fs::copy(bundled.join(GUIDE), &components[0].stage)
            .map_err(|e| err("AGENT_DOCUMENTATION_COPY_FAILED", e))?;
        copy_tree(&bundled.join("docs"), &components[1].stage)?;
        copy_tree(
            &bundled.join("integrations").join("skills"),
            &components[2].stage,
        )?;
        assert_same(
            &expected,
            &manifest_of(
                &components[0].stage,
                &components[1].stage,
                &components[2].stage,
            )?,
        )?;
        for (i, c) in components.iter().enumerate() {
            if exists(&c.target) {
                rename_owned(l, &c.target, &c.backup)?;
                moved.push(i);
            }
        }
        for (i, c) in components.iter().enumerate() {
            rename_owned(l, &c.stage, &c.target)?;
            placed.push(i);
        }
        assert_same(&expected, &installed_manifest(l)?)
    })();
    if let Err(e) = attempt {
        let (mut tried, mut ok, mut failed) = (0, 0, Vec::new());
        let mut step = |label: String, r: Result<()>| {
            tried += 1;
            match r {
                Ok(()) => ok += 1,
                Err(e) => failed.push(format!("{label}:{}", e.message)),
            }
        };
        for &i in &placed {
            let c = &components[i];
            step(
                format!("remove-installed:{}", c.name),
                (|| {
                    if !exists(&c.target) {
                        return Ok(());
                    }
                    remove_owned(l, &c.target, false).inspect_err(|_| {
                        // 被占着删不掉：挪到本次的暂存名下，备份仍能放回。
                        if exists(&c.target) && !exists(&c.stage) {
                            let _ = rename_owned(l, &c.target, &c.stage);
                        }
                    })
                })(),
            );
        }
        for &i in moved.iter().rev() {
            let c = &components[i];
            step(
                format!("restore-backup:{}", c.name),
                (|| {
                    if exists(&c.target) {
                        return Err(err("ROLLBACK_TARGET_PRESENT", c.target.display()));
                    }
                    if !exists(&c.backup) {
                        return Err(err("ROLLBACK_BACKUP_MISSING", c.backup.display()));
                    }
                    rename_owned(l, &c.backup, &c.target)
                })(),
            );
        }
        for c in &components {
            step(
                format!("remove-stage:{}", c.name),
                if exists(&c.stage) {
                    remove_owned(l, &c.stage, true)
                } else {
                    Ok(())
                },
            );
        }
        let suffix = if failed.is_empty() {
            format!(" [rollback attempted={tried},succeeded={ok},failed=0]")
        } else {
            format!(
                " [rollback attempted={tried},succeeded={ok},failed={}; failures={}]",
                failed.len(),
                failed[..failed.len().min(4)].join("|")
            )
        };
        return Err(AgentError {
            message: format!("{}{suffix}", e.message),
            ..e
        });
    }
    for &i in &moved {
        let c = &components[i];
        if rename_owned(l, &c.backup, &c.committed).is_ok() {
            let _ = remove_owned(l, &c.committed, true);
        }
    }
    Ok(Outcome::Installed)
}

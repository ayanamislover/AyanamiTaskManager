//! 设置页「Agent 接入」的七个宿主方法与启动时的两个作业（W6d）：都交给 atm-agents，在工作线程上做（会读写用户目录里
//! 的配置、可能起 `claude` 命令行），结果经事件循环交回。
//!
//! 能不能动用户的 Agent 配置（修复作业、切换时同步客户端、装 Agent 文档）由这里判定（[`gate`]，2.0
//! `shouldRepairMcpConfigs`）：打包运行在产品默认数据根上；或者打包烟测把全部配置根都隔离进
//! `ATM_SMOKE_AGENT_CONFIG_ROOT`。开发构建、任何一个数据根覆盖（`ATM_DATA_DIR`、`AYANAMI_TASK_DATA_DIR`、只覆盖 N
//! 的 `ATM3_DATA_DIR`）或被重定向的配置根下的隔离运行都不修，也不在切换时改客户端：那时写进全局配置的启动方式
//! 与这次运行的服务对不上。用户在设置页点的安装 / 修复 / 卸载不受限制。
//!
//! 令牌只在 `getMcpConfigs` 的返回里（给用户复制的 HTTP 配置），不进日志。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use atm_agents::env::AgentEnv;
use atm_agents::integrations::{Agents, Gate};
use atm_agents::{AgentError, Settings};
use atm_domain::principal::Principal;
use atm_service::write::Service;
use serde_json::Value;

use crate::paths::Layout;

struct ServiceSettings(Arc<Service>);

impl Settings for ServiceSettings {
    fn memory_profile_enabled(&self) -> bool {
        self.0.memory_profile_enabled()
    }

    fn commit_memory_profile(
        &self,
        principal: &Principal,
        enabled: bool,
    ) -> Result<(), AgentError> {
        let op = self.0.auto_op_id()?;
        self.0.set_memory_profile(principal, enabled, &op)?;
        Ok(())
    }
}

fn var(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

fn inside(root: &Path, candidate: &Path) -> bool {
    let normal = |p: &Path| {
        p.to_string_lossy()
            .trim_end_matches(['\\', '/'])
            .to_lowercase()
    };
    let (root, candidate) = (normal(root), normal(candidate));
    candidate == root || candidate.starts_with(&format!("{root}\\"))
}

/// 修复与同步能不能运行（模块说明）。
pub fn gate(layout: &Layout, env: &AgentEnv) -> bool {
    decide(
        layout.packaged,
        || {
            crate::core_process::product_default_data_root(&layout.data_dir)
                && defaults_match(
                    Roots {
                        l: &layout.data_dir,
                        n: &layout.v3_root,
                        localappdata: &env.localappdata,
                        appdata: &env.appdata,
                        home: &env.home,
                    },
                    crate::win::known_local_app_data(),
                    crate::win::known_roaming_app_data(),
                    crate::win::known_profile(),
                )
        },
        var,
        [&env.appdata, &env.localappdata, &env.home],
    )
}

/// 这次运行实际用的根：共享的 L、服务的 N、三个客户端配置根。
struct Roots<'a> {
    l: &'a Path,
    n: &'a Path,
    localappdata: &'a Path,
    appdata: &'a Path,
    home: &'a Path,
}

fn same(a: &Path, b: &Path) -> bool {
    let normal = |p: &Path| {
        p.to_string_lossy()
            .trim_end_matches(['\\', '/'])
            .to_lowercase()
    };
    normal(a) == normal(b)
}

/// 产品默认（peer W6 r1 P1-04）：L 与 N 都是这个用户 Local AppData 下的产品根，三个客户端配置根就是这个用户
/// 真实的已知文件夹（不是被环境变量重定向的）。只把 N（`ATM3_DATA_DIR`）指到演练位置的运行不算：那时修复写进
/// 全局配置的启动方式、切换时同步的客户端，都与这次运行的服务对不上。
fn defaults_match(
    r: Roots<'_>,
    local: Option<PathBuf>,
    roaming: Option<PathBuf>,
    profile: Option<PathBuf>,
) -> bool {
    let (Some(local), Some(roaming), Some(profile)) = (local, roaming, profile) else {
        return false;
    };
    same(r.l, &local.join("AyanamiTaskManager"))
        && same(r.n, &local.join(atm_install_state::startup::V3_DIR_NAME))
        && same(r.localappdata, &local)
        && same(r.appdata, &roaming)
        && same(r.home, &profile)
}

/// [`gate`] 的判定本身：环境变量与「是不是产品默认数据根」由调用方给（用例里换成假的）。
fn decide(
    packaged: bool,
    product_root: impl FnOnce() -> bool,
    var: impl Fn(&str) -> Option<String>,
    config_roots: [&PathBuf; 3],
) -> bool {
    if !packaged {
        return false;
    }
    let packaged_smoke = var("ATM_PACKAGED_SMOKE").as_deref() == Some("1");
    let repair_flag = var("ATM_SMOKE_MCP_CONFIG_REPAIR");
    if !packaged_smoke && repair_flag.is_none() {
        // 三个数据根覆盖里任何一个指到别处都是隔离运行（N 的 `ATM3_DATA_DIR` 也算）。
        let overridden = ["ATM_DATA_DIR", "AYANAMI_TASK_DATA_DIR", "ATM3_DATA_DIR"]
            .iter()
            .any(|k| var(k).is_some_and(|v| !v.is_empty()));
        return !overridden && product_root();
    }
    // 烟测标记一律走这一支：全部配置根都要在隔离根里。
    if !packaged_smoke || repair_flag.as_deref() != Some("1") {
        return false;
    }
    let Some(root) = var("ATM_SMOKE_AGENT_CONFIG_ROOT").filter(|r| !r.is_empty()) else {
        return false;
    };
    let root = PathBuf::from(root);
    config_roots.iter().all(|p| inside(&root, p))
}

/// 本进程的 Agent 环境。烟测里宿主留着真实的用户目录（WebView2 要它），Agent 配置在合成的家目录里。
pub(crate) fn agent_env(layout: &Layout) -> AgentEnv {
    let shim = crate::paths::mcp_entry(&layout.app_dir, layout.packaged).exe;
    #[allow(unused_mut)]
    let mut env = AgentEnv::from_process(&layout.data_dir, &shim);
    // 只换家目录不够：Claude Desktop 的配置在 APPDATA / LOCALAPPDATA，`claude` 命令行按 PATH 找到的是真的那个，
    // 会去改真实的 `~/.claude.json`。所以三样一起落进合成的家目录，PATH 不用。
    #[cfg(feature = "smoke")]
    if let Some(home) = std::env::var_os("ATM_SMOKE_CORE_USERPROFILE").filter(|h| !h.is_empty()) {
        let home = PathBuf::from(home);
        env.appdata = home.join("AppData").join("Roaming");
        env.localappdata = home.join("AppData").join("Local");
        env.path = None;
        env.home = home;
    }
    env
}

pub fn build(layout: &Layout, svc: Arc<Service>) -> Arc<Agents> {
    let env = agent_env(layout);
    let gate = Gate {
        manage_configs: gate(layout, &env),
    };
    // 仍握着 2.x 配置的会话：链接下的宿主入口（`--mcp-stdio` / mcp-stdio.cjs），与这一份宿主本身。
    let extra = vec![
        layout
            .data_dir
            .join("current")
            .join("AyanamiTaskManager.exe")
            .to_string_lossy()
            .into_owned(),
        layout.host_exe.to_string_lossy().into_owned(),
    ];
    Arc::new(Agents::new(
        env,
        Arc::new(ServiceSettings(svc)),
        gate,
        extra,
    ))
}

/// 错误交给界面的形状：码、以码开头的话，与可选的细节（切换失败时的整份报告）。
pub type Failure = (String, String, Option<Value>);

fn failure(e: AgentError) -> Failure {
    (e.code, e.message, e.details)
}

/// 一个桥方法。`endpoint` 是 Agent 入口的地址与令牌（入口开着时）。
pub fn call(
    agents: &Agents,
    principal: &Principal,
    method: &str,
    args: &[Value],
    endpoint: Option<(String, String)>,
) -> Result<Value, Failure> {
    let s = |i: usize| args.get(i).and_then(Value::as_str).unwrap_or_default();
    match method {
        "getMcpConfigs" => {
            let Some((url, token)) = endpoint else {
                return Err((
                    "RUNTIME_NOT_READY".into(),
                    "RUNTIME_NOT_READY: 服务入口还没开".into(),
                    None,
                ));
            };
            agents.mcp_configs(principal, &url, &token)
        }
        "getMcpBridges" => agents.bridges(principal),
        "getMemoryProfile" => agents.memory_profile(principal).map(Value::Bool),
        "setMemoryProfile" => agents.set_memory_profile(
            principal,
            args.first().and_then(Value::as_bool) == Some(true),
        ),
        "installMcp" => agents.install_mcp(principal, s(0)),
        "getAgentIntegrations" => agents.integrations(principal),
        "manageAgentIntegration" => agents.manage(principal, s(0), s(1)),
        other => Err(AgentError::new(
            "AGENTS_METHOD_UNKNOWN",
            format!("没有这个方法：{other}"),
        )),
    }
    .map_err(failure)
}

/// 安装包里的 Agent 文档（`<app>\resources\agent`）；开发构建没有。
fn bundled_docs(layout: &Layout) -> Option<PathBuf> {
    let p = layout.app_dir.join("resources").join("agent");
    (layout.packaged && p.is_dir()).then_some(p)
}

/// 入口开着之后跑一次：先换 Agent 文档（Skills 的来源在里面），再修旧配置、补 Skill（atm-jobs 的两个作业）。
/// 都只在 [`gate`] 放行时做；出错只记日志，不影响服务。
pub fn startup(agents: &Agents, layout: &Layout) -> Vec<String> {
    if !gate(layout, &agents.env) {
        return vec!["agents: repair skipped (not the product data root)".to_owned()];
    }
    atm_jobs::agents::run(agents, bundled_docs(layout).as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn vars(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> + use<> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |k| map.get(k).cloned()
    }

    fn roots(base: &str) -> [PathBuf; 3] {
        let b = PathBuf::from(base);
        [
            b.join("home").join("AppData").join("Roaming"),
            b.join("home").join("AppData").join("Local"),
            b.join("home"),
        ]
    }

    fn run(packaged: bool, product: bool, env: &[(&str, &str)], base: &str) -> bool {
        let r = roots(base);
        decide(packaged, || product, vars(env), [&r[0], &r[1], &r[2]])
    }

    /// 2.0 `shouldRepairMcpConfigs` 的各条（`apps/desktop/test/mcp-launch.test.ts`）。
    #[test]
    fn the_repair_gate_follows_2x() {
        let sandbox = r"C:\sandbox\agents";
        // 打包 + 产品默认数据根：修。
        assert!(run(true, true, &[], sandbox));
        // 开发构建、或数据根被改到别处（ATM_DATA_DIR / 合成 LOCALAPPDATA）：不修。
        assert!(!run(false, true, &[], sandbox));
        assert!(!run(true, false, &[], sandbox));
        // 烟测：两个标记都要、隔离根要给、三个配置根都要在里面。
        let smoke = [
            ("ATM_PACKAGED_SMOKE", "1"),
            ("ATM_SMOKE_MCP_CONFIG_REPAIR", "1"),
            ("ATM_SMOKE_AGENT_CONFIG_ROOT", sandbox),
        ];
        assert!(run(true, false, &smoke, sandbox));
        assert!(!run(false, false, &smoke, sandbox));
        assert!(!run(true, true, &smoke[..2], sandbox));
        assert!(!run(true, true, &[smoke[0], smoke[2]], sandbox));
        assert!(!run(
            true,
            true,
            &[("ATM_SMOKE_MCP_CONFIG_REPAIR", "1"), smoke[2]],
            sandbox
        ));
        assert!(!run(
            true,
            true,
            &[smoke[0], ("ATM_SMOKE_MCP_CONFIG_REPAIR", "0"), smoke[2]],
            sandbox
        ));
        // 烟测标记在、但配置根有一个是真的：不修，也不走「产品数据根」的捷径。
        assert!(!run(true, true, &smoke, r"C:\Users\real"));
        assert!(!run(
            true,
            true,
            &[smoke[0], smoke[1], ("ATM_SMOKE_AGENT_CONFIG_ROOT", "")],
            sandbox
        ));
    }

    /// peer W6 r1 P1-04：任何一个数据根覆盖（包括只覆盖 N 的 `ATM3_DATA_DIR`）都关掉无人值守的修复与同步；
    /// 「产品默认」要 L、N 与三个客户端配置根全是这个用户真实的已知文件夹。
    #[test]
    fn an_isolated_root_disables_unattended_repair() {
        let sandbox = r"C:\sandbox\agents";
        for key in ["ATM3_DATA_DIR", "ATM_DATA_DIR", "AYANAMI_TASK_DATA_DIR"] {
            assert!(
                !run(true, true, &[(key, r"C:\isolated-v3")], sandbox),
                "{key}"
            );
            // 空值不算覆盖（与 v3_root 的读法一致）。
            assert!(run(true, true, &[(key, "")], sandbox), "{key} empty");
        }
        let local = PathBuf::from(r"C:\Users\u\AppData\Local");
        let roaming = PathBuf::from(r"C:\Users\u\AppData\Roaming");
        let profile = PathBuf::from(r"C:\Users\u");
        let l = local.join("AyanamiTaskManager");
        let n = local.join("AyanamiTaskManager3");
        let check = |l: &Path, n: &Path, lad: &Path, ad: &Path, home: &Path| {
            defaults_match(
                Roots {
                    l,
                    n,
                    localappdata: lad,
                    appdata: ad,
                    home,
                },
                Some(local.clone()),
                Some(roaming.clone()),
                Some(profile.clone()),
            )
        };
        assert!(check(&l, &n, &local, &roaming, &profile));
        assert!(check(
            Path::new(r"c:\users\U\appdata\local\ayanamitaskmanager\"),
            &n,
            &local,
            &roaming,
            &profile
        ));
        let elsewhere = Path::new(r"C:\isolated");
        assert!(
            !check(&l, elsewhere, &local, &roaming, &profile),
            "N elsewhere"
        );
        assert!(
            !check(elsewhere, &n, &local, &roaming, &profile),
            "L elsewhere"
        );
        assert!(
            !check(&l, &n, elsewhere, &roaming, &profile),
            "LOCALAPPDATA redirected"
        );
        assert!(
            !check(&l, &n, &local, elsewhere, &profile),
            "APPDATA redirected"
        );
        assert!(
            !check(&l, &n, &local, &roaming, elsewhere),
            "USERPROFILE redirected"
        );
        assert!(!defaults_match(
            Roots {
                l: &l,
                n: &n,
                localappdata: &local,
                appdata: &roaming,
                home: &profile
            },
            Some(local.clone()),
            None,
            Some(profile.clone())
        ));
    }

    #[test]
    fn inside_compares_whole_components() {
        assert!(inside(Path::new(r"C:\a\b"), Path::new(r"c:\A\B\c")));
        assert!(inside(Path::new(r"C:\a\b\"), Path::new(r"C:\a\b")));
        assert!(!inside(Path::new(r"C:\a\b"), Path::new(r"C:\a\bc")));
        assert!(!inside(Path::new(r"C:\a\b"), Path::new(r"C:\a")));
    }
}

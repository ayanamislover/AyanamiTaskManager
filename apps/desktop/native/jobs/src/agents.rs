//! Agent 接入的两个启动作业（W6d / W6e；03 P-016）：`agents.docs` 把安装包里的 Agent 文档装进 `L`，`agents.repair`
//! 修旧配置、补缺的 Skill。宿主在入口开着之后、放行条件成立时调一次；System 主体在这里构造（本 crate 是唯一能构造
//! 它的地方）。出错只记下原因，不影响服务。

use std::path::Path;

use atm_agents::integrations::Agents;
use atm_domain::principal::{JobId, Principal};

/// 先换文档（Skills 的来源在里面），再修复。返回给宿主日志的几行（不含令牌）。
pub fn run(agents: &Agents, bundled_docs: Option<&Path>) -> Vec<String> {
    let mut lines = Vec::new();
    if let Some(bundled) = bundled_docs {
        match agents.install_docs(&Principal::system_job(JobId::AgentsDocs), bundled) {
            Ok(outcome) => lines.push(format!("agents.docs: {outcome:?}")),
            Err(e) => lines.push(format!("agents.docs failed: {}", e.message)),
        }
    }
    match agents.repair(&Principal::system_job(JobId::AgentsRepair)) {
        Ok(done) => lines.push(format!("agents.repair: {}", done.view())),
        Err(e) => lines.push(format!("agents.repair failed: {}", e.message)),
    }
    lines
}

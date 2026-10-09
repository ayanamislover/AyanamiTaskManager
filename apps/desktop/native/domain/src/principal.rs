//! 主体（03 §2，P-001～P-003）。
//!
//! - `Principal` 不实现 `Deserialize`，字段私有：输入里的 `actor`、`session`、`principal`
//!   之类的字段永远不能把 Agent 提升为 User（P-001）。
//! - 构造函数只给可信入口用：ui-bridge（User/WebView、User/Tray）、e2e-adapter（User/E2eTest，
//!   仅 `e2e` feature）、atm-http（Agent）、atm-sync（Phone）、jobs（System）。Rust 没有「只对某几个
//!   crate 可见」，所以由静态守卫（`tests/principal_guard.rs`）扫描工作区，越界调用即红。
//! - 03 §2 写的是 `Agent{session}`，但同一节又说 session「由服务按输入解析并校验」。所以 HTTP
//!   入口构造的 Agent 只带连接组身份（10 R11 A4，不是凭据），解析好的 session 放在服务的 `Actor` 里。

/// 界面来源。`(generation, epoch)` 在构造时写进来，投递应答时再核对（03 U4）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UiSurface {
    WebView {
        generation: u64,
        epoch: u64,
    },
    Tray,
    #[cfg(feature = "e2e")]
    E2eTest,
}

/// 这次构建带不带 e2e 的界面来源。正式宿主编译期断言它是 false（`host/src/main.rs`）：
/// 与 e2e 适配器合在同一次构建里、特性被合并进来时，宿主就编译不过（W5d 发布守卫）。
pub const E2E_SURFACE: bool = cfg!(feature = "e2e");

/// 03 §2.4 的 job。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum JobId {
    StartupRecover,
    Maintenance,
    MetricsCapture,
    NotifyObserve,
    UpdateCheck,
    SyncLoop,
    DispatchTrack,
    AgentsRepair,
    AgentsDocs,
    MemoryRelease,
    Keepalive,
}

impl JobId {
    pub const ALL: &'static [JobId] = &[
        JobId::StartupRecover,
        JobId::Maintenance,
        JobId::MetricsCapture,
        JobId::NotifyObserve,
        JobId::UpdateCheck,
        JobId::SyncLoop,
        JobId::DispatchTrack,
        JobId::AgentsRepair,
        JobId::AgentsDocs,
        JobId::MemoryRelease,
        JobId::Keepalive,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            JobId::StartupRecover => "startup.recover",
            JobId::Maintenance => "maintenance",
            JobId::MetricsCapture => "metrics.capture",
            JobId::NotifyObserve => "notify.observe",
            JobId::UpdateCheck => "update.check",
            JobId::SyncLoop => "sync.loop",
            JobId::DispatchTrack => "dispatch.track",
            JobId::AgentsRepair => "agents.repair",
            JobId::AgentsDocs => "agents.docs",
            JobId::MemoryRelease => "memory.release",
            JobId::Keepalive => "keepalive",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Inner {
    User {
        surface: UiSurface,
    },
    Agent {
        client_group: Option<String>,
    },
    Phone {
        space_id: String,
        device_id: String,
        command_id: String,
    },
    System {
        job: JobId,
    },
}

/// 调用服务的主体。只能由可信入口构造，见模块说明。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Principal(Inner);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PrincipalKind {
    User,
    Agent,
    Phone,
    System,
}

impl PrincipalKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            PrincipalKind::User => "USER",
            PrincipalKind::Agent => "AGENT",
            PrincipalKind::Phone => "PHONE",
            PrincipalKind::System => "SYSTEM",
        }
    }
}

impl Principal {
    /// ui-bridge：U1～U9 全部通过之后才调用（03 §2.1）。
    pub fn trusted_ui(surface: UiSurface) -> Self {
        Principal(Inner::User { surface })
    }

    /// atm-http：Bearer 鉴权成功之后调用。`client_group` 来自 A4 的客户端身份，不是凭据。
    pub fn authenticated_agent(client_group: Option<String>) -> Self {
        Principal(Inner::Agent { client_group })
    }

    /// atm-sync：命令解密、验签、`validateCommand` 通过之后调用（03 §2.3）。
    pub fn verified_phone(space_id: String, device_id: String, command_id: String) -> Self {
        Principal(Inner::Phone {
            space_id,
            device_id,
            command_id,
        })
    }

    /// jobs：调度器为一个 job 构造。
    pub fn system_job(job: JobId) -> Self {
        Principal(Inner::System { job })
    }

    pub fn kind(&self) -> PrincipalKind {
        match self.0 {
            Inner::User { .. } => PrincipalKind::User,
            Inner::Agent { .. } => PrincipalKind::Agent,
            Inner::Phone { .. } => PrincipalKind::Phone,
            Inner::System { .. } => PrincipalKind::System,
        }
    }

    pub fn ui_surface(&self) -> Option<UiSurface> {
        match self.0 {
            Inner::User { surface } => Some(surface),
            _ => None,
        }
    }

    pub fn client_group(&self) -> Option<&str> {
        match &self.0 {
            Inner::Agent { client_group } => client_group.as_deref(),
            _ => None,
        }
    }

    pub fn job(&self) -> Option<JobId> {
        match self.0 {
            Inner::System { job } => Some(job),
            _ => None,
        }
    }

    /// Phone 的 `(space, device, command)`。执行时 actor 记为 `PHONE:<device>`（03 C-05）。
    pub fn phone(&self) -> Option<(&str, &str, &str)> {
        match &self.0 {
            Inner::Phone {
                space_id,
                device_id,
                command_id,
            } => Some((space_id, device_id, command_id)),
            _ => None,
        }
    }
}

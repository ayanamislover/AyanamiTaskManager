//! operation 映射表（10 R11 A3 第 1–3 条）：每个写 operation 用哪些能力、Agent 要不要 session、可能落到哪种目标、
//! 幂等身份按什么定位。桥签发（W4g）、`resolve` 与服务的目标核对都查这一张表。
//!
//! - **需要 session** 不单独登记，从能力目录的「Agent 需 session」列推出（03 §3）：同一个 operation 有几个入口
//!   能力时（例如 `record.create` 的普通记录与反馈），看 Agent 能用的那些。
//! - **目标种类** 列出这个 operation 所有分支可能的落点。只有全部分支都是 NONE 的 operation，缺 op_id 时才不必
//!   resolve（A3「什么时候调用 resolve」第 2 条）。
//! - **调用索引**：落点取决于服务端状态的三个 operation（begin、`project.create`、不带目标的 `quick.promote`）
//!   按 (principal, operation, op_id) 全局定位回执；其余 operation 带 session 时在 SESSION 命名空间、
//!   不带时在 ACTOR 命名空间（[`namespace`]）。
//!
//! 测试里扫描全部 `*_OPERATION` 常量与这张表逐项比对：新增 operation 而不登记，或者登记了不存在的，都会变红。

use atm_domain::capability::Capability;
use atm_domain::principal::PrincipalKind;

/// 一个分支的落点（A3 第 2 条）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetKind {
    /// 不写任何会随范围恢复回退的东西（quick registry、全局设置），或者报错不写。
    None,
    /// 已有项目。
    Project,
    /// 当前数据根的知识库。
    Knowledge,
    /// 本次写事务里新建的项目。
    Create,
}

/// 幂等身份的定位方式。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Namespace {
    /// 回执表的全局调用索引：(principal_kind, principal_id, operation, op_id)。
    Call,
    /// (scope, session lineage, op_id)。
    Session,
    /// (scope, actor, op_id)。
    Actor,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Op {
    pub operation: &'static str,
    /// 入口能力（至少一个）。
    pub capabilities: &'static [Capability],
    /// 所有分支可能的落点。
    pub targets: &'static [TargetKind],
    /// 落点取决于服务端状态：走调用索引，桥不补目标选择器，resolve 判定的结果作为 expected_target。
    pub indexed: bool,
}

impl Op {
    /// Agent 调这个 operation 要不要 session：Agent 能用的入口能力里有任何一个需要。
    pub fn agent_needs_session(&self) -> bool {
        self.capabilities
            .iter()
            .any(|c| c.grant().agent && c.grant().agent_needs_session)
    }

    /// 所有分支都是 NONE：缺 op_id 时只补 auto id，不 resolve。
    pub fn always_none(&self) -> bool {
        self.targets.iter().all(|t| *t == TargetKind::None)
    }
}

use Capability as C;
use TargetKind::{Create, Knowledge, None as NoTarget, Project};

/// 全部写 operation。
pub const OPS: &[Op] = &[
    // ---- 会话
    Op {
        operation: crate::session::BEGIN_OPERATION,
        capabilities: &[C::SessionBegin],
        // ① TRASHED、③ quick、⑤ 报错都是 NONE；② EXISTING；④ CREATE。
        targets: &[NoTarget, Project, Create],
        indexed: true,
    },
    Op {
        operation: crate::session::END_OPERATION,
        capabilities: &[C::SessionEnd],
        targets: &[Project],
        indexed: false,
    },
    Op {
        operation: crate::session::FORCE_CLOSE_OPERATION,
        capabilities: &[C::SessionForceClose],
        targets: &[Project],
        indexed: false,
    },
    // ---- 项目
    Op {
        operation: crate::project::CREATE_OPERATION,
        capabilities: &[C::ProjectCreate],
        targets: &[Create],
        indexed: true,
    },
    Op {
        operation: crate::project::PATH_ATTACH_OPERATION,
        capabilities: &[C::ProjectPathAttach],
        targets: &[Project],
        indexed: false,
    },
    Op {
        operation: crate::project::RESTORE_DECIDE_OPERATION,
        capabilities: &[C::ProjectRestoreRequestDecide],
        targets: &[Project],
        indexed: false,
    },
    // ---- quick
    Op {
        operation: crate::quick::CREATE_OPERATION,
        capabilities: &[C::QuickCreate],
        targets: &[NoTarget],
        indexed: false,
    },
    Op {
        operation: crate::quick::UPDATE_OPERATION,
        capabilities: &[C::QuickUpdate],
        targets: &[NoTarget],
        indexed: false,
    },
    Op {
        operation: crate::quick::PROMOTE_OPERATION,
        capabilities: &[C::QuickPromote],
        // 带目标项目 P 是 EXISTING(P)（落点固定，ACTOR 命名空间）；不带目标是 CREATE（调用索引）。
        targets: &[Project, Create],
        indexed: true,
    },
    // ---- 知识库
    Op {
        operation: crate::knowledge::SAVE_OPERATION,
        capabilities: &[C::KnowledgeUserEdit],
        targets: &[Knowledge],
        indexed: false,
    },
    Op {
        operation: crate::knowledge::ARCHIVE_OPERATION,
        capabilities: &[C::KnowledgeArchive],
        targets: &[Knowledge],
        indexed: false,
    },
    Op {
        operation: crate::knowledge::AGENT_SAVE_OPERATION,
        capabilities: &[C::KnowledgeAgentSave],
        targets: &[Knowledge],
        indexed: false,
    },
    // ---- 进度与记录
    Op {
        operation: crate::memory::PROGRESS_OPERATION,
        capabilities: &[C::ProgressAdd],
        targets: &[Project],
        indexed: false,
    },
    Op {
        operation: crate::memory::PROJECT_UPDATE_OPERATION,
        // Agent 的项目级进度（atm_progress_add scope=project）与 User 的发布共用这个 operation。
        capabilities: &[C::ProgressAdd, C::ProjectUpdatePublish],
        targets: &[Project],
        indexed: false,
    },
    Op {
        operation: crate::memory::RECORD_OPERATION,
        capabilities: &[C::RecordCreate, C::RecordFeedback],
        targets: &[Project],
        indexed: false,
    },
    // ---- 工作项
    Op {
        operation: crate::work::CREATE_OPERATION,
        capabilities: &[C::WorkCreate],
        targets: &[Project],
        indexed: false,
    },
    Op {
        operation: crate::work::PATCH_OPERATION,
        capabilities: &[C::WorkPatch],
        targets: &[Project],
        indexed: false,
    },
    Op {
        operation: crate::work::VERIFY_AND_COMPLETE_OPERATION,
        capabilities: &[C::WorkVerifyComplete],
        targets: &[Project],
        indexed: false,
    },
    Op {
        operation: crate::work::CHECKLIST_OPERATION,
        capabilities: &[C::ChecklistUpdate],
        targets: &[Project],
        indexed: false,
    },
    Op {
        operation: crate::work::CHECKLIST_BATCH_OPERATION,
        capabilities: &[C::ChecklistUpdate],
        targets: &[Project],
        indexed: false,
    },
    Op {
        operation: crate::work::REVIEW_REQUEST_OPERATION,
        capabilities: &[C::ReviewRequest],
        targets: &[Project],
        indexed: false,
    },
    Op {
        operation: crate::work::REVIEW_SUBMIT_OPERATION,
        capabilities: &[C::ReviewSubmit],
        targets: &[Project],
        indexed: false,
    },
    Op {
        operation: crate::work::planning::OBJECTIVE_OPERATION,
        capabilities: &[C::WorkPlan],
        targets: &[Project],
        indexed: false,
    },
    Op {
        operation: crate::work::planning::MILESTONE_OPERATION,
        capabilities: &[C::WorkPlan],
        targets: &[Project],
        indexed: false,
    },
    Op {
        operation: crate::work::planning::DRAFT_OPERATION,
        capabilities: &[C::ProjectUpdateDraft],
        targets: &[Project],
        indexed: false,
    },
    Op {
        operation: crate::work::import::IMPORT_OPERATION,
        capabilities: &[C::ImportApply],
        targets: &[Project],
        indexed: false,
    },
    // ---- 全局实体：不在任何恢复范围里（05），NONE。
    Op {
        operation: crate::settings::SET_OPERATION,
        capabilities: &[C::SettingsWrite],
        targets: &[NoTarget],
        indexed: false,
    },
    Op {
        operation: crate::settings::NOTIFICATION_MODE_OPERATION,
        capabilities: &[C::NotificationModeSet],
        targets: &[NoTarget],
        indexed: false,
    },
    Op {
        operation: crate::settings::BACKUP_POLICY_OPERATION,
        capabilities: &[C::SettingsWrite],
        targets: &[NoTarget],
        indexed: false,
    },
    Op {
        operation: crate::views::CREATE_OPERATION,
        capabilities: &[C::SavedViewManage],
        targets: &[NoTarget],
        indexed: false,
    },
    Op {
        operation: crate::views::UPDATE_OPERATION,
        capabilities: &[C::SavedViewManage],
        targets: &[NoTarget],
        indexed: false,
    },
    Op {
        operation: crate::views::DELETE_OPERATION,
        capabilities: &[C::SavedViewManage],
        targets: &[NoTarget],
        indexed: false,
    },
];

/// 查表。不在表里的 operation 是实现缺陷（测试保证每个常量都登记了）。
pub fn find(operation: &str) -> Option<&'static Op> {
    OPS.iter().find(|o| o.operation == operation)
}

/// 这次写入的幂等身份按什么定位：调用索引的 operation 恒为 Call（`quick.promote` 带目标时除外，它的落点固定）；
/// 其余带 session 时是 SESSION，不带时是 ACTOR（User、System、Phone 恒为 ACTOR）。
pub fn namespace(op: &Op, kind: PrincipalKind, has_session: bool, has_target: bool) -> Namespace {
    if op.indexed && !(op.operation == crate::quick::PROMOTE_OPERATION && has_target) {
        Namespace::Call
    } else if kind == PrincipalKind::Agent && has_session {
        Namespace::Session
    } else {
        Namespace::Actor
    }
}

/// resolve 判定的分支目标，桥写进重试上下文的 `expected_target`（A3）：
/// `{kind:"NONE"}`、`{kind:"EXISTING", scope:{kind, id}, generation}` 或 `{kind:"CREATE"}`。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    None,
    Existing {
        scope: crate::receipts::ReceiptScope,
        generation: Option<i64>,
    },
    Create,
}

impl Target {
    pub fn to_json(&self) -> serde_json::Value {
        use serde_json::json;
        match self {
            Target::None => json!({ "kind": "NONE" }),
            Target::Create => json!({ "kind": "CREATE" }),
            Target::Existing { scope, generation } => json!({
                "kind": "EXISTING",
                "scope": { "kind": scope.kind.as_str(), "id": scope.id },
                "generation": generation,
            }),
        }
    }

    /// 解析客户端（桥）带回来的 expected_target。形状不对返回 None，由调用方报参数错误。
    pub fn from_json(v: &serde_json::Value) -> Option<Target> {
        use crate::receipts::{ReceiptScope, ScopeKind};
        let o = v.as_object()?;
        match o.get("kind")?.as_str()? {
            "NONE" if o.len() == 1 => Some(Target::None),
            "CREATE" if o.len() == 1 => Some(Target::Create),
            "EXISTING" => {
                let s = o.get("scope")?.as_object()?;
                let id = s.get("id")?.as_str()?.to_owned();
                let kind = match s.get("kind")?.as_str()? {
                    "PROJECT" => ScopeKind::Project,
                    "KNOWLEDGE" => ScopeKind::Knowledge,
                    _ => return None,
                };
                let generation = match o.get("generation") {
                    None | Some(serde_json::Value::Null) => None,
                    Some(g) => Some(g.as_i64()?),
                };
                if o.keys()
                    .any(|k| !["kind", "scope", "generation"].contains(&k.as_str()))
                {
                    return None;
                }
                Some(Target::Existing {
                    scope: ReceiptScope { kind, id },
                    generation,
                })
            }
            _ => None,
        }
    }

    /// 执行时按当前状态重新判定的分支 `now` 与上下文里的 `self` 对照（A3「目标核对」）。
    /// 同一 scope 只是世代变了 → SCOPE_RESTORED；其余不一致 → TARGET_CHANGED。
    pub fn check(&self, now: &Target) -> Result<(), atm_domain::error::DomainError> {
        use atm_domain::error::{DomainError, ErrorCode};
        match (self, now) {
            (Target::None, Target::None) | (Target::Create, Target::Create) => Ok(()),
            (
                Target::Existing {
                    scope: a,
                    generation: ga,
                },
                Target::Existing {
                    scope: b,
                    generation: gb,
                },
            ) if a == b => {
                if ga.is_some() && ga != gb {
                    Err(DomainError::new(
                        ErrorCode::SCOPE_RESTORED,
                        "目标范围在 resolve 之后被恢复过：先重新读取，再决定是否重做",
                    )
                    .detail(
                        "scope",
                        serde_json::json!({ "kind": a.kind.as_str(), "id": a.id }),
                    )
                    .detail("expected_generation", *ga)
                    .detail("current_generation", *gb))
                } else {
                    Ok(())
                }
            }
            _ => Err(target_changed(self, now)),
        }
    }
}

/// `TARGET_CHANGED`（409，不可重试）：details 带新旧目标；fix 是不带上下文的原调用（W4e 的生成器负责）。
pub fn target_changed(expected: &Target, now: &Target) -> atm_domain::error::DomainError {
    use atm_domain::error::{DomainError, ErrorCode};
    DomainError::new(
        ErrorCode::TARGET_CHANGED,
        "这次写入的落点在 resolve 之后变了：看 details 里的新旧目标，再决定是否不带上下文重新发起",
    )
    .detail("expected_target", expected.to_json())
    .detail("current_target", now.to_json())
}

/// 落点固定（EXISTING(s)）的写入带了 expected_target：它必须就是 s，返回要交给 R4 屏障比较的世代。
/// 别的 scope、NONE、CREATE 都是 `TARGET_CHANGED`。
pub fn fixed(
    expected: &Target,
    scope: &crate::receipts::ReceiptScope,
) -> Result<Option<i64>, atm_domain::error::DomainError> {
    match expected {
        Target::Existing {
            scope: s,
            generation,
        } if s == scope => Ok(*generation),
        other => Err(target_changed(
            other,
            &Target::Existing {
                scope: scope.clone(),
                generation: None,
            },
        )),
    }
}

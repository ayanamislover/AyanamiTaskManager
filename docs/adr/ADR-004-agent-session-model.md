# ADR-004：通用 Agent / Session / Parent Session

状态：Accepted

持久 `agent_id` 与一次运行 `session_id` 分离，Subagent 用 `parent_session_id` 表达谱系。连接状态和工作状态分离，`client_kind` 仅用于显示诊断，领域规则不得根据 Codex、Claude 或模型名推断能力。

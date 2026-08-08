# ADR-005：Quick Task 不建项目库并可安全晋升

状态：Accepted

一次性短任务仅写 Registry 的 Quick Task 表。需要任务树、依赖、多 Agent 或跨会话时，通过可恢复 saga 挂入既有项目或创建新项目；成功前保留源 Quick Task，重复晋升按幂等键返回同一目标。

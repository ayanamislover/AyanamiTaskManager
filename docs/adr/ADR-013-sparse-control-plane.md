# ADR-013：稀疏控制面

状态：Accepted

ATM 记录项目状态变化，不记录 Agent 工作轨迹。进度优先来自检查项、子任务和状态，最后才接受 10% 桶的 Agent 估算；相同状态/桶/摘要 hash 返回 no-op；常规读取依赖事件 dirty flag 与 delta，不轮询。mutation 默认短 ACK，日志、命令和隐藏推理不得进入项目事实。

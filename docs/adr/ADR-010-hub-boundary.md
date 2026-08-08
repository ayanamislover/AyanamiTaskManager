# ADR-010：不复制 Hub 通信与评审职责

状态：Accepted

TaskManager 只管理目标、任务、进度、阻塞、决策、证据和 Agent session。消息投递、可信用户指令、终端、写入冲突、代码评审 bundle 与工作树继续由 CrossAgent Hub 负责，避免两个产品产生互相冲突的权限与真相。

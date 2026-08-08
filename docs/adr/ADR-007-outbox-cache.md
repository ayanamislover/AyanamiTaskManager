# ADR-007：禁止 ATTACH 跨库写，使用 outbox

状态：Accepted

WAL 下不得通过 `ATTACH DATABASE` 同时修改 Registry 与 Project。项目事务写入 outbox，提交后 dispatcher 更新 Registry 的摘要和全局搜索投影；失败可重试，缓存可从项目库序列重建。`.aytproj` 使用项目已有的 `fflate` 依赖生成 zip，避免引入第二个归档库。

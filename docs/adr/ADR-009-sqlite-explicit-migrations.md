# ADR-009：直接 SQL + 显式迁移

状态：Accepted

使用 `better-sqlite3`、参数化 SQL 与独立迁移目录，不引入 ORM。该依赖已在参考仓库验证原生备份、事务和 Electron ABI；精确版本 12.2.0 实测只含 SQLite 3.50.2，被启动门槛拒绝，因此升级并锁定 13.0.2。直接 SQL 能明确控制 WAL、FTS5、递归 CTE、迁移哈希和崩溃边界。

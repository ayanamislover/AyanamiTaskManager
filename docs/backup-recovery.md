# 备份与恢复

## 备份模型

ATM 使用 SQLite Online Backup 对活动 WAL 数据库创建一致性快照。每个备份同时生成 manifest，记录项目、schema、原因、大小、SHA-256、创建时间和验证时间。写入目录前使用临时文件，完整性检查通过后再原子改名。

备份类型包括：

- `MANUAL`：用户手动创建；
- `DAILY` / `WEEKLY`：自动维护；
- `PRE_ARCHIVE` / `PRE_TRASH`：归档或移入垃圾箱之前；
- `PRE_RESTORE`：恢复覆盖当前数据之前；
- `EXPORT`：生成 `.aytproj` 之前；
- `PRE_MIGRATION`：需要迁移保护时。

自动维护按调度时刻记录日期，避免跨 UTC 日期重跑产生重复日备份。默认保留 7 个日备份和 4 个周备份，可在设置中修改或关闭自动策略。手动和操作前备份不受日/周保留数清理。

## 手动备份

桌面端进入项目“数据工具 → 立即备份”。CLI：

```powershell
pnpm atm backup create --project ATM
pnpm atm backup list --project ATM
```

备份完成只有在 SQLite `quick_check`、文件 SHA-256 和 manifest 写入都成功后才返回成功。失败事件会出现在总览“需要处理”。

## 恢复流程

1. 选择项目备份并点击“恢复”；
2. ATM 先创建当前状态的 `PRE_RESTORE` 备份；
3. 校验目标备份 SHA-256 和 SQLite 完整性；
4. 关闭对应项目连接，原子替换项目数据库；
5. 重新打开并迁移到当前 schema；
6. 若任一步失败，回滚到替换前文件。

CLI：

```powershell
pnpm atm backup restore <backup-id>
pnpm atm doctor
```

恢复后应检查项目目标、任务数、最近事件序列和 `doctor`。不要在应用仍运行时手工复制 WAL/SHM 文件替换数据库。

## 导出与异机恢复

`.aytproj` 包含一致性数据库快照和校验清单，适合长期保存和迁移。JSON/CSV 是只读审查格式，不能替代可恢复数据库。

```powershell
pnpm atm export ATM --format aytproj
pnpm atm export ATM --format json
pnpm atm export ATM --format csv
```

异机恢复前先退出 ATM，保留原数据目录副本，再使用应用支持的导入/恢复入口。不要只复制 Registry：正式任务事实位于各项目独立数据库。

## 灾难恢复核对

- Registry 与项目库必须来自一致的受支持备份流程；
- `manifest.json` 中 SHA-256 必须与文件一致；
- `pnpm atm doctor` 或桌面状态必须报告 Registry、项目库和 FTS 正常；
- 验证一个任务详情、一次项目搜索和最新事件序列；
- 保留恢复前自动生成的备份，直到人工确认完成。

# 备份与恢复

## 备份模型

3.0 的每份备份都是整库备份：`%LOCALAPPDATA%\AyanamiTaskManager3\backups\<id>\` 下的一个目录，包含

- `atm.sqlite`：在旁路只读连接上用 `VACUUM INTO` 得到的一致快照，不占写线程；
- `artifacts\`：附件文件的副本；
- `manifest.json`（格式 `atm3-backup-1`）：库文件的 SHA-256 与大小、迁移清单、库身份、各项目与知识库的序号和世代，以及附件清单与摘要。

每个文件先写临时文件、落盘后再改名，manifest 最后写；登记进库之后才算一份完整的备份。

备份类型包括：

- `MANUAL`：用户手动创建；
- `DAILY` / `WEEKLY`：自动维护；
- `PRE_ARCHIVE` / `PRE_TRASH`：归档或移入垃圾箱之前；
- `PRE_RESTORE`：恢复覆盖当前数据之前。

导出 `.aytproj` 不再先建备份。2.x 留下的备份只读登记、在列表里单独列出，不受 3.0 保留策略管理，也不能按 3.0 的范围恢复；能导入的在应用内作为项目或知识库导入。

自动维护在当天（UTC 日期）还没有日备份时做一份，最近一份周备份满 7 天（或没有）时做一份。保留策略按备份类型分组，每种只留最新的若干份：默认日备份 2 份、周备份 2 份，其余每种（手动、`PRE_*`）各 2 份，可在设置中调整。**新建一份后，同一种里超出的最旧备份会连同目录一起删除**——手动备份也不例外，所以「新建备份」本身就是一次「留哪几份」的决定。恢复时选中的备份会固定 30 天，固定期内的备份不删。

## 手动备份

桌面端进入项目“数据工具 → 立即备份”，得到一份整库备份。新建备份会按上面的保留策略淘汰最旧的手动备份，因此只能由用户在界面操作：CLI 的 `backup create` 在本地直接拒绝（退出码 3，不发请求），用 `daemon.json` 里的 Agent 凭证直调 REST 得到 `403 USER_AUTHORIZATION_REQUIRED`，见 [本地安全模型](security-model.md)。CLI 只能查看：

```powershell
& "$env:LOCALAPPDATA\AyanamiTaskManager\current\AyanamiTaskManager.exe" --cli backup list --limit 20
```

备份失败会出现在总览“项目提醒”。

### 外部备份工具的目录边界

使用文件级备份软件时，先从托盘“完全退出” ATM，再备份 `%LOCALAPPDATA%\AyanamiTaskManager3` 下的 `data\`、`backups\`
与 `conversion.json`、`authority.json`；`exports\` 按需保留，`quarantine\`、`superseded\` 里是隔离或封存的旧数据，需要时一并保留。
`runtime\`、`logs\`、`staging\`、`webview\` 不需要备份。

需要保留回退 2.x 的能力时，一并备份 `%LOCALAPPDATA%\AyanamiTaskManager`。备份工具必须启用“跳过重解析点/目录链接”，并明确排除
其中的 `current\`：它是指向安装根（`%LOCALAPPDATA%\AyanamiTaskManagerDesktop`）的 junction，不属于
用户数据，跟随它会把整套程序文件重复计入备份。该目录里随安装包重新分发的 Guide、docs、skills 也不是恢复任务状态所必需的内容。

仓库提供的 `migrate:data-root` 只迁移 2.x 的数据根，同样跳过所有符号链接和 junction；迁移完成后由新安装版重新创建
`current\`。不要手工把旧 `current\` 复制到新设备。

## 恢复流程

在桌面端选择一份整库备份，并选择恢复范围（某个项目，或知识库）：

1. ATM 逐项核对目标备份：文件、manifest、SHA-256、SQLite `quick_check`、schema 与时间线；
2. 先创建当前状态的 `PRE_RESTORE` 整库备份；
3. 以只读方式打开备份库，在一个事务内把该范围的数据换成备份里的样子；
4. 任一步失败，事务整体回滚，当前数据不变。

Agent 与 Session 属于身份与审计，不随项目恢复回退；恢复后旧的读游标失效，需要重新读取。只接受同一时间线的备份，来自整库恢复之前的备份会被拒绝。按范围恢复同样只能由用户在界面操作，CLI 的 `backup restore` 在本地拒绝。

服务起不来、窗口提示数据库读不出时，用离线整库恢复：从托盘退出 ATM，运行窗口里给出的 `recover --offline` 命令（可先加 `--list` 查看每份备份的问题），输入备份 ID 确认。当前数据整体移入 `%LOCALAPPDATA%\AyanamiTaskManager3\quarantine\`，不删除；备份之后的写入不会保留。完整步骤见[排障指南](troubleshooting.md#数据库读不出)。

恢复后应检查项目目标、任务数、最近事件序列和 `--cli doctor`。不要在应用仍运行时手工复制 WAL/SHM 文件替换数据库。

## 导出与异机迁移

`.aytproj` 包含单个项目的一致数据库快照、附件和校验清单，适合长期保存和迁移；导入一律作为新项目。JSON/CSV 是只读审查格式，不能替代可恢复数据库。导出只能由用户在项目“数据工具”中操作，CLI 的 `export` 在本地拒绝；文件写到 `%LOCALAPPDATA%\AyanamiTaskManager3\exports\`。

异机迁移请用 `.aytproj` 按项目导出、导入，共享知识用知识库的 Markdown 导出、导入。不要把整个数据目录直接复制到另一台电脑当迁移手段：转换清单绑定这台电脑的 2.x 数据根，路径不同或那台电脑上的 2.x 数据不同时，会进入「需要选择数据来源」。也不要只复制 `atm.sqlite` 而丢掉 `-wal` 与 `artifacts\`。

## 灾难恢复核对

- 只用 ATM 自己的入口恢复：数据工具按范围恢复，或 `recover --offline` 整库恢复；不要手工替换 `data\` 里的文件；
- `manifest.json` 中 SHA-256 必须与文件一致（恢复前 ATM 会逐项核对）；
- `--cli doctor` 或桌面状态必须报告 `quick_check` 为 `ok`，`problems` 为空；
- 验证一个任务详情、一次项目搜索和最新事件序列；
- 保留恢复前自动生成的 `PRE_RESTORE` 备份与 `quarantine\` 里的旧数据，直到人工确认完成。

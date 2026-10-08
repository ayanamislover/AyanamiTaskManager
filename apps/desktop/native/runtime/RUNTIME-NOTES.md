# atm-runtime：3.x 无头运行时（W4i）

`atm-runtime` 是 ATM 3 单进程服务的运行时库：准入 → 启动判定 / 转换 → 权威判定 → 开放 Agent 入口 → 调度。
正式宿主（W6）链接这个库；`atm-runtime.exe` 是开发与端到端用例用的无头二进制，不进安装包。
调度器与客户端存活判定在 `atm-jobs`：System 主体只许在 `jobs` crate 里构造（`domain/tests/principal_guard.rs`）。

规格：`output/atm3-spec/07-conversion-state-machine.md` §2–§8；W3 peer r1 的 P2-02（`output/peer-atm3-w3-r1.md`）。

## 顺序

```
admit（service.lock + 旧版静止）
  └─ 撤掉上一个进程留下的 daemon.json（拿到准入就没有别的实例在服务）
decide 循环（最多 8 圈）
  ├─ ResumeSeal / Quarantine → seal → 再判定
  ├─ FreshInstall → fresh_install → 再判定
  ├─ FirstConversion / Restart → （discard_attempt）→ run（写启动进度）→ 再判定
  ├─ FinishPublishing → finish_publishing → 再判定
  ├─ SourceConflict → 冲突（入口一个都不开）
  └─ Published(M) → 权威判定
权威判定
  ├─ must_compare_before_serving(A, M, L)：A 不是与 M 对得上的 v3，或 L 不是 M 记下的转换源
  │    → 阻塞比较（写启动进度 COMPARE …）→ judge
  │        Serve / ResumeAfterRollback → 开放入口
  │        Reconvert → choose_legacy（封存）→ 再判定
  │        Conflict → enter_conflict（只写 startup-state.json）
  └─ 否则 → 开放入口，后台比较 → judge
           Conflict → 撤下入口（调度器 → HTTP → daemon.json）→ enter_conflict
开放入口：lease 记录（daemon.lock）→ HTTP → daemon.json → 见证（setup 拉起时）→ 调度器
```

`Event` 按发生顺序报给 `Options::observe`，进程内用例（`tests/boot.rs`）核对它。

## 与 setup 的交接（P2-02）

- **同一份代码**：setup 的进程身份（`procs`）、SERVICE_HEALTHY 核对（`service`）与 START 等待循环（`handoff::await_healthy`）
  都在 `atm-install-state`，setup 只委托。`tests/handoff.rs` 用的正是这一份，拉起真实的 `atm-runtime.exe`。
- **3.x 的运行目录在 `N\runtime`**：lease、daemon.json 与 atm-mcp 桥读的是同一份（`handoff::runtime_dir_for`）。
  setup 找正在运行的新式服务时两处都看（`Env::service_lease`）。
- **预算按这个进程的这次启动累计**：`ProgressWatch::resume` 从 txn 目录里的 `start-wait.json`（`WaitLedger`）续算总上限、首条进度期限
  与「多久没动」。只认同一 txn、同一进程（pid + 创建时间）的记账。时间用墙钟毫秒落盘；墙钟往回拨按「还没过去」算（只会多等）。
- **`/health` 不要令牌**：setup 从不读令牌。Host、Origin、Sec-Fetch 照旧检查；setup 的探测带 `Host: 127.0.0.1:<端口>`。
  只有 `GET /health` 豁免，`POST /health` 照样要令牌。
- **写 `A` 之前等准入放掉**：进程结束之后系统释放文件锁是异步的；`settle_for_rollback` 最多等 `ADMISSION_GRACE`（10 s），
  还没放掉才拒绝（`V3_STILL_ADMITTED`）。真实进程用例实测到过刚退出时锁还在。

## 端到端用例（`tests/handoff.rs`，真实自有进程）

| 用例 | 场景 |
| ---- | ---- |
| `a_start_is_healthy_only_through_its_own_witness` | START：全新安装到 SERVICE_HEALTHY；别的 txn 去等同一个健康的进程，永远超时 |
| `a_long_conversion_is_waited_out_through_its_progress` | F15：转换比首条进度期限长，靠进度一直等到健康；记账落盘 |
| `a_restarted_setup_takes_over_with_the_budget_already_spent` | F18 / P2-02：setup 重启接管同一进程，已用掉的总预算不重来 |
| `a_stuck_start_is_given_up_and_cancelled_without_authority` | F16 与取消：卡住判 START_STUCK；进程活着时拒绝写 `A`；结束它之后按持久阶段（未发布）不写 `A` |
| `a_dead_conversion_fails_the_start_and_the_next_one_restarts` | F17：转换中途进程死了 → START_HOST_EXITED、不写 `A`；再次启动走 S3，换新 generation |
| `the_rollback_authority_is_written_only_after_the_process_is_gone` | 回滚事务：已发布的进程退出之后才写 `A=legacy`；再升级无损接回（resume-after-rollback） |
| `a_conflicting_start_never_publishes_an_entry` | 源身份不符：进程活着、持有准入，没有 daemon.json、没有见证，`N\runtime` 只多出启动状态；setup 等不到健康 |

`--drill-pace-ms`、`--drill-hold-at` 只在开发二进制里：前者把小样本的转换拉长，后者让进度停在某一阶段（模拟卡住）。

## 进程内用例（`tests/boot.rs`；sweep 在 `jobs/tests/sweep.rs`）

- 入口顺序固定（lease → HTTP → daemon.json → 见证 → 调度器）；撤下后不再监听、daemon.json 不在。
- 源身份不符：阻塞比较判冲突，没有 lease 记录、HTTP、daemon.json、调度器。
- `A=legacy`：比较完才有入口；没动过 2.x 无损接回，动过就封存重转。
- 后台比较判冲突：先撤下全部入口，再写启动状态。
- 同一个 `N` 只有一个实例拿得到准入（F7）。
- sweep：客户端进程还在的 session 30 min 没心跳也不收，退出了的收（CLIENT_EXITED），没有身份的按普通超时。

## 不在 W4i

- 同步、派单与其余调度任务（W7）；冲突时它们本来就不起。
- 可信界面里的选源（W5/W6）：`Conflicted` 持有准入，等用户选。
- 旧版静止的判定：开发二进制直接判静止（联调里旧根由用例控制），不做任何检查；正式宿主（W6）接入 setup 已有的判定。
- 安装与回滚全流程、掉电（W8）。

## 验红

`output/w4-evidence/mutations/mut-w4i.py`（runtime、jobs、store、state、http 五组），证据 `output/w4-evidence/w4i-*-mutation-evidence.json`；
第一轮评审的修订 `mut-w4i-r2.py`（runtime、state 两组），证据 `w4i-r2-*-mutation-evidence.json`。

## W4i 第一轮评审（`output/peer-atm3-w4i-r1.md`）：CHANGES_REQUESTED

绑定 c3ee68a。无 P0。正常交接、入口顺序、SERVICE_HEALTHY 唯一成功、源身份先拦、`/health` 免令牌与 10 s 等锁释放都被接受。

| 编号 | 问题 | 修订 |
| ---- | ---- | ---- |
| P1-01 | 开发二进制的真实根守卫可绕过：设了 `ATM3_DATA_DIR` 就不再保护默认 3.x 根；`\\?\` 扩展路径拼同一个根也放过；守卫只是字符串比较 | `guard`：受保护的根固定列出（2.x、3.x 默认数据根、默认安装根，以及 `ATM_DATA_DIR`、`AYANAMI_TASK_DATA_DIR`、`ATM3_DATA_DIR` 指向的根），覆盖不取消保护。比较真实位置：最近一个存在的祖先经 `canonicalize` 解开 junction、符号链接、扩展前缀与短名，再接上还不存在的部分；任一方向的包含都算重叠。`--n`、`--legacy`、`--install-root` 都查，彼此也不能重叠（N 落在 L 里，写 N 就动了源数据）。查在任何写入之前 |
| P1-02 | 直接丢弃 `Serving`（不调 `stop`）先放掉准入，后台比较线程却还持有入口：第二个实例能起来，两个 `/health` 同时答 200 | `Serving` 实现 `Drop`，与 `stop` 走同一个有序关闭：后台比较不再动手、等它结束，再撤入口；准入是最后一个释放的字段。`Serving` 自己存一份 observe 供丢弃时用 |
| P2-01 | 没有记账（setup 在首次落盘前退出、首次落盘失败、记账损坏）时，接管从接管时刻重新给满总预算 | 没有可信的记账时，总预算从被等进程的创建时间算（它就是本次 START 拉起的）；无推进的窗口从接管时刻算。记账写不下时报一次 `START_LEDGER_UNWRITABLE`，等待照常 |

- 评审的其余意见：`/health` 的注释改成实际应答的字段；上面「不在 W4i」里开发二进制的静止判定写成实际的做法（直接判静止）。比较线程的取消只在比较返回后检查、`join` 没有单独的超时，这是响应性的边界：关闭会等比较做完。
- **用例**：
  - `tests/guard.rs::every_spelling_of_a_protected_root_is_refused_before_any_write`：合成的 LOCALAPPDATA 下十二种拼法（默认根、带覆盖、扩展路径、junction、根内、包含根、2.x 根当源、三个覆盖变量各自指向的根、N 在 L 里、默认安装根）都以退出码 2 拒绝，受保护的目录前后一样，也没有建出 N、L。正常的沙箱根能起来由 `tests/handoff.rs` 覆盖。
  - `guard` 的单元用例：重叠的判定（大小写、两个方向、前缀不算）；解析保留不存在的末段、扩展前缀与普通写法解到同一处。
  - `tests/boot.rs::dropping_a_serving_closes_everything_before_the_admission_goes`：后台比较卡住时直接丢弃，丢弃要等比较放开才返回；返回时旧 `/health` 不答、daemon.json 已撤、准入已放，下一个实例这时才起来。
  - `install-state` 的 `startup::tests::a_takeover_without_a_ledger_counts_from_the_host_creation`（没有记账、对不上的记账：3 h 前拉起的进程接管后立刻到总上限；1 min 前拉起的照常等），`handoff::tests::an_unwritable_ledger_is_reported_once_and_the_wait_goes_on`。原用例「别的进程、别的 txn 的记账不算：从头开始」随之改为「记账不算，总预算从本进程的创建时间算」。

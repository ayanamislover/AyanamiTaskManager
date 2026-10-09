# atm-runtime：3.x 无头运行时（W4i）

`atm-runtime` 是 ATM 3 单进程服务的运行时库：准入 → 启动判定 / 转换 → 权威判定 → 开放 Agent 入口 → 调度。
正式宿主（`atm-host`，W5a 起）链接这个库，在自己的进程里跑服务；`atm-runtime.exe` 是开发与端到端用例用的无头二进制，不进安装包。
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
  只有 `GET /health` 豁免，`POST /health` 照样要令牌。应答只有 setup 核对用的 `pid`、`instanceId`、
  `generation`（lease 序号）三项，没有版本与别的状态（W4 r1 P2-01；`tests/boot.rs` 守精确的字段集合）。
- **写 `A` 之前等准入放掉**：进程结束之后系统释放文件锁是异步的；`settle_for_rollback` 最多等 `ADMISSION_GRACE`（10 s），
  还没放掉才拒绝（`V3_STILL_ADMITTED`）。真实进程用例实测到过刚退出时锁还在。

## 端到端用例（`tests/handoff.rs`，真实自有进程）

| 用例                                                               | 场景                                                                                                     |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `a_start_is_healthy_only_through_its_own_witness`                  | START：全新安装到 SERVICE_HEALTHY；别的 txn 去等同一个健康的进程，永远超时                               |
| `a_long_conversion_is_waited_out_through_its_progress`             | F15：转换比首条进度期限长，靠进度一直等到健康；记账落盘                                                  |
| `a_restarted_setup_takes_over_with_the_budget_already_spent`       | F18 / P2-02：setup 重启接管同一进程，已用掉的总预算不重来                                                |
| `a_stuck_start_is_given_up_and_cancelled_without_authority`        | F16 与取消：卡住判 START_STUCK；进程活着时拒绝写 `A`；结束它之后按持久阶段（未发布）不写 `A`             |
| `a_dead_conversion_fails_the_start_and_the_next_one_restarts`      | F17：转换中途进程死了 → START_HOST_EXITED、不写 `A`；再次启动走 S3，换新 generation                      |
| `the_rollback_authority_is_written_only_after_the_process_is_gone` | 回滚事务：已发布的进程退出之后才写 `A=legacy`；再升级无损接回（resume-after-rollback）                   |
| `a_conflicting_start_never_publishes_an_entry`                     | 源身份不符：进程活着、持有准入，没有 daemon.json、没有见证，`N\runtime` 只多出启动状态；setup 等不到健康 |

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
- 可信界面里的选源（W6，B2）：`Conflicted` 持有准入，等用户选。
- 旧版静止的判定：开发二进制直接判静止（联调里旧根由用例控制），不做任何检查；正式宿主用 [`legacy_quiesce`]（W5a，见下）。

## 正式宿主（W5a）

- `atm-host` 在工作线程上调 `start`，事件循环与托盘不等它；结果经事件循环交回，宿主持有 `Serving` / `Conflicted` 到退出。
  退出时 `Serving::stop`：后台比较不再动手 → 撤入口 → 最后放准入。
- 嵌入用的句柄：`Serving::service()` 给出服务与入口的 tokio `Handle`（界面派发用，入口撤下后是 `None`）；
  `Serving::take_background()` 交出后台比较的结论通道，宿主在自己的线程上等。
- `legacy_quiesce(L)`：`L\runtime\daemon.lock` 的持有者还活着（pid 与创建时间对得上，与 setup 的 `service_lease` 同一口径）就 `Wait`。
  宿主每 5 s 再试一次，不计入失败重试的节流（10 min 内最多 5 次，退避 2、4、8、16 s）。
- 文件归属：宿主日志（`N\logs\host.log`）、`N\runtime\host.json`、WebView2 数据（`N\webview`）都在 `N`；
  旧根 `L` 只用它的路径给单实例互斥与管道起名（setup 的 QUIT、launcher 的 SHOW / WAKE 照旧），不写任何文件。
  setup 找 host.json 时两处都看（`quiesce::host_records`）。
- 用例：`host/tests/single_process.rs`（GUI 路径不引用 Node core 的静态守卫；真实进程：`/health` 答宿主 pid、
  没有子进程、`L` 没有文件、QUIT 后 daemon.json 撤下；旧版 lease 在时不开入口，走了再开）。
  验红：`output/w5-evidence/mutations/mut-w5a.py`。
- Node 入口（`--cli`、`--doctor`、`--mcp-stdio`、安装探测）在 W6 换掉之前照旧，它们还用 `L`。
- 安装与回滚全流程、掉电（W8）。

## 验红

`output/w4-evidence/mutations/mut-w4i.py`（runtime、jobs、store、state、http 五组），证据 `output/w4-evidence/w4i-*-mutation-evidence.json`；
第一轮评审的修订 `mut-w4i-r2.py`（runtime、state 两组），证据 `w4i-r2-*-mutation-evidence.json`。
第二轮评审的修订 `mut-w4i-r3.py`（runtime），证据 `w4i-r3-runtime-mutation-evidence.json`。
第三轮评审的修订 `mut-w4i-r4.py`（runtime、store、state 三组），证据 `w4i-r4-*-mutation-evidence.json`。
第四轮评审的修订 `mut-w4i-r5.py`（state、setup、runtime 三组），证据 `w4i-r5-*-mutation-evidence.json`。
第五轮评审留下的 P2 的修订 `mut-w4i-r6.py`（launcher），证据 `w4i-r6-launcher-mutation-evidence.json`。

## W4i 第一轮评审（`output/peer-atm3-w4i-r1.md`）：CHANGES_REQUESTED

绑定 c3ee68a。无 P0。正常交接、入口顺序、SERVICE_HEALTHY 唯一成功、源身份先拦、`/health` 免令牌与 10 s 等锁释放都被接受。

| 编号  | 问题                                                                                                                          | 修订                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-01 | 开发二进制的真实根守卫可绕过：设了 `ATM3_DATA_DIR` 就不再保护默认 3.x 根；`\\?\` 扩展路径拼同一个根也放过；守卫只是字符串比较 | `guard`：受保护的根固定列出（2.x、3.x 默认数据根、默认安装根，以及 `ATM_DATA_DIR`、`AYANAMI_TASK_DATA_DIR`、`ATM3_DATA_DIR` 指向的根），覆盖不取消保护。比较真实位置：最近一个存在的祖先经 `canonicalize` 解开 junction、符号链接、扩展前缀与短名，再接上还不存在的部分；任一方向的包含都算重叠。`--n`、`--legacy`、`--install-root` 都查，彼此也不能重叠（N 落在 L 里，写 N 就动了源数据）。查在任何写入之前 |
| P1-02 | 直接丢弃 `Serving`（不调 `stop`）先放掉准入，后台比较线程却还持有入口：第二个实例能起来，两个 `/health` 同时答 200            | `Serving` 实现 `Drop`，与 `stop` 走同一个有序关闭：后台比较不再动手、等它结束，再撤入口；准入是最后一个释放的字段。`Serving` 自己存一份 observe 供丢弃时用                                                                                                                                                                                                                                                    |
| P2-01 | 没有记账（setup 在首次落盘前退出、首次落盘失败、记账损坏）时，接管从接管时刻重新给满总预算                                    | 没有可信的记账时，总预算从被等进程的创建时间算（它就是本次 START 拉起的）；无推进的窗口从接管时刻算。记账写不下时报一次 `START_LEDGER_UNWRITABLE`，等待照常                                                                                                                                                                                                                                                   |

- 评审的其余意见：`/health` 的注释改成实际应答的字段；上面「不在 W4i」里开发二进制的静止判定写成实际的做法（直接判静止）。比较线程的取消只在比较返回后检查、`join` 没有单独的超时，这是响应性的边界：关闭会等比较做完。
- **用例**：
  - `tests/guard.rs::every_spelling_of_a_protected_root_is_refused_before_any_write`：合成的 LOCALAPPDATA 下十二种拼法（默认根、带覆盖、扩展路径、junction、根内、包含根、2.x 根当源、三个覆盖变量各自指向的根、N 在 L 里、默认安装根）都以退出码 2 拒绝，受保护的目录前后一样，也没有建出 N、L。正常的沙箱根能起来由 `tests/handoff.rs` 覆盖。
  - `guard` 的单元用例：重叠的判定（大小写、两个方向、前缀不算）；解析保留不存在的末段、扩展前缀与普通写法解到同一处。
  - `tests/boot.rs::dropping_a_serving_closes_everything_before_the_admission_goes`：后台比较卡住时直接丢弃，丢弃要等比较放开才返回；返回时旧 `/health` 不答、daemon.json 已撤、准入已放，下一个实例这时才起来。
  - `install-state` 的 `startup::tests::a_takeover_without_a_ledger_counts_from_the_host_creation`（没有记账、对不上的记账：3 h 前拉起的进程接管后立刻到总上限；1 min 前拉起的照常等），`handoff::tests::an_unwritable_ledger_is_reported_once_and_the_wait_goes_on`。原用例「别的进程、别的 txn 的记账不算：从头开始」随之改为「记账不算，总预算从本进程的创建时间算」。

## W4i 第二轮评审（`output/peer-atm3-w4i-r2.md`）：CHANGES_REQUESTED

绑定 db72787。无 P0。P1-02（丢弃有序关闭）、P2-01（无记账时的总预算、写不下只报一次）、证据绑定、守卫对大小写、尾随分隔符、`.`、`..`、8.3 短名、junction 后接不存在末段、N=L 的拒绝都被确认。评审在补测 panic 与锁 poison 时被内容过滤中断，报告没有写完总结论。

| 编号     | 问题                                                                                                      | 修订                                                                                                                                                                                                                                                |
| -------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2-P1-01 | 守卫只解析参数根本身：`N\runtime` 是指向 3.x 根的 junction 时，准入锁、lease、daemon.json 都写进了 3.x 根 | `guard::refuse_links`：在任何写入之前遍历三个根里已有的整棵树，有任何 reparse point（junction、符号链接等）或有不止一个名字的文件（硬链接）就拒绝，不管它指向哪里、不管哪个子目录会被写。根本身可以是链接（它的真实位置已经比过），从它的目标往下看 |

| 补查 | （评审中断前在查的「启动中途出错」）`entries::publish` 在 HTTP 已开、daemon.json 已写之后出错或 panic 时直接返回：HTTP 随 tokio 运行时关掉，daemon.json 却留下了，也没走撤下 | `Entries` 在 HTTP 开起来时就建好，之后每一步出错（`?`）或 panic 都由它的 `Drop` 撤下（与 `withdraw` 同一个 `close`，只是不报 `Withdrawn`）；`withdraw` 之后的丢弃什么也不做 |

- 边界：检查之后别的进程再往根里塞的链接不在开发二进制的防线里；运行时自己新建的目录和文件都是普通的。
- **用例**：`tests/guard.rs::links_inside_a_given_root_are_refused_before_any_write`：`N\runtime` 指向 3.x 根、N 深处的目录指向不受保护的地方、N 里的文件是 3.x 根里文件的硬链接、N 本身是 junction 而它的 runtime 指向 3.x 根、`L\data` 指向 2.x 根、安装根的 state 指向默认安装根，都以退出码 2 拒绝；每个用例的根与受保护的树逐字节不变，被指向的不受保护目录也还是空的。
- **用例**：`tests/boot.rs::a_publish_that_fails_halfway_leaves_no_entry_behind`：写见证失败（安装根的 `state` 是文件）与 observe 在 `Descriptor` 时 panic 两种，`start` 返回或展开之后旧端口不答 `/health`、daemon.json 已撤、准入已放，下一个实例照常起来。

## W4i 第三轮评审（`output/peer-atm3-w4i-r3.md`）：CHANGES_REQUESTED

绑定 4636f76。无 P0。守卫在任何写入之前、遍历出错即拒绝、根是链接时从目标往下看，`Entries` 的丢弃撤下与 `withdraw` 不重复、在展开时先撤入口再放准入，都被确认。评审同样在中途被内容过滤中断，没有写完总结论。

| 编号     | 问题                                                                                                                                                                                                                                                    | 修订                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R3-P1-01 | 路径片段仍能越出已检查的根，而且不需要链接：`--txn-start x/../../../../…` 让见证写进受保护根；`N\runtime\seal.json` 的 name 写成绝对路径，封存续做时 `join` 换掉基路径，`N\data` 被移出 N                                                               | 拼进路径的名字一律先过 `atm_install_state::is_path_name`：1–128 个 ASCII 字母、数字或 `-`，不是 Windows 保留设备名，所以 `join` 之后恰好是基目录下的一层。从磁盘读来的不合格就按损坏处理：`M` 的 generation（`M` 损坏，有发布物就隔离进 `N\quarantine\unknown-…`）、封存意图的 name（当作没有可续做的意图，按新的一次封存走）、setup 的 journal（id、`to`、`from`）与 `app.json`（`current`、`previous`，它们经 `app_dir_for` 拼进安装根）。从参数、调用方来的不合格就在动手之前拒绝：开发二进制的 `--txn-start`（退出 2）、`start` 的 handoff txn（准入之前失败）、`run` / `fresh_install` / `discard_attempt` 的 generation（`Refused`，`discard_attempt` 不会再拿它去 `remove_dir_all`）、`service_healthy` 的 txn（读见证之前） |
| 自查     | 第二轮修订的链接守卫（93fcfb3）有竞争：setup 拉起本进程的同时就往安装根里原子写记账，列出之后被改名走的临时文件让 `symlink_metadata` 报 NotFound，守卫按「无法检查」拒绝了正常的启动（变异复原套件里 `handoff.rs` 的一次 `START_HOST_EXITED` 由此而来） | 列出之后、检查之前就不见的条目跳过（它已经不在，写入不会经过它），别的读不出来的错误照旧拒绝                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

- 其余拼路径的点都不取外来的名字：封存的新目录名由合格的 generation 与时间戳（只留字母、数字、`-`）组成；SNAPSHOT 的 `rel` 来自对 `L` 的现场枚举，`M.source_files` 只拿来比较、不拼路径；`staging`、`quarantine`、`superseded`、`health`、`runtime` 都是常量。
- **用例**：
  - `install-state`：`tests::path_names_are_one_plain_component`（`.`、`..`、分隔符、盘符、扩展前缀、空格、设备名、非 ASCII、超长都不算）；`tests::state_whose_names_are_not_plain_is_invalid`（journal 的 id / `to` / `from`、`app.json` 的 `current` / `previous` 带 `..`、盘符、分隔符时 `Invalid`，`legacy:1.4.0` 与 `3.0.0-beta.1+x` 照常）；`service::tests::a_txn_that_is_not_a_plain_name_is_refused_before_reading`（`x\..\service-T1` 指向一份内容自洽的见证，读之前就拒绝）。
  - `store/tests/names.rs::a_generation_that_is_not_one_name_is_refused_before_any_write`：`run`、`fresh_install`、`discard_attempt` 拿 `..\..\victim` 等都 `Refused`，`N\staging\..\..\victim` 指着的目录原样不动，N 也没建。
  - `guard` 的单元用例 `an_entry_that_vanished_is_skipped_but_other_errors_refuse`、`concurrent_atomic_writes_in_a_root_do_not_refuse_it`（一个线程在根里不停写临时文件再改名，守卫 3 s 内反复检查都通过）。
  - `runtime`：`tests/guard.rs::a_txn_that_is_not_one_name_is_refused_before_any_write`（评审的反例原样与另四种写法，退出 2，安装根空、N 与 L 没建、受保护的树逐字节不变）；`tests/boot.rs::a_txn_that_is_not_one_name_is_refused_before_admission`；`tests/boot.rs::names_persisted_in_n_never_lead_outside_it`（封存意图的 name 是 N 外的绝对路径、`M` 的 generation 是 `..\..\outside`：都隔离在 N 里，N 旁边什么也没多出来，之后照常起来）。

## W4i 第四轮评审（`output/peer-atm3-w4i-r4.md`）：CHANGES_REQUESTED

绑定 b3b0154。无 P0。R3-P1-01 的拼接点清单、损坏状态的恢复去向、消失条目的竞争修订（在已披露的开发守卫边界内）与 38 条变异的源码绑定都被确认。

| 编号     | 问题                                                                                                                                                                                                     | 修订                                                                                                                                                                                                                                                                                                                                                 |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R4-P1-01 | bda1abd 的 journal / `app.json` 校验把 setup 自己写出的 `legacy:<1.x>` 判成损坏：迁移后的 `previous`、反向迁移的 `to` 与之后的 `current`。回滚、恢复、维护受阻，迁移成功后的正常准入也会走 NeedsRecovery | `atm_install_state::is_version_ref`：普通版本号，或恰好一个 `LEGACY_PREFIX` 加普通版本号；journal 的 `to`、`from` 与 `app.json` 的 `current`、`previous` 都用它。前缀只认一次，剩下的照旧按单层版本号核对（`legacy:legacy:…`、`legacy:..\x`、`legacy:` 不算）。前缀常量移进 install-state，setup 的 `legacy::LEGACY_PREFIX` 就是它，两边只有一个来源 |
| R4-P2-01 | reparse 判定的变异只因为 junction 用例的提示措辞变红，新加的文件符号链接那一种没跑到                                                                                                                     | 文件符号链接拆成单独的用例，断言行为：退出 2、没有拿到准入（`N\runtime` 没建出来）、受保护的树逐字节不变。建不了文件符号链接（ERROR_PRIVILEGE_NOT_HELD，评审的沙箱就是这样）时明确打印 SKIPPED 返回，不当作通过的证据                                                                                                                                |

- **用例**：
  - `setup` 的 `store::tests::every_state_setup_writes_reads_back`：用 setup 自己的 `new_txn_id`、`legacy::legacy_pointer`、`store::enter` / `Store::set_pointer` 写出迁移（`from = legacy:1.4.0`）、反向迁移（`to = legacy:1.4.0`）、普通更新、首次安装（带预发布与构建号的版本）的事务，以及迁移后、反向迁移后、更新后、回滚后、首次安装后的 `app.json`，逐个经 `Store::load` / `Store::pointer` 原样读回。
  - `install-state` 的 `tests::state_whose_names_are_not_plain_is_invalid` 加上合法的 `legacy:` 引用（每个字段）与嵌套前缀、空版本、带盘符的反例。
  - `tests/guard.rs::a_file_symbolic_link_inside_a_root_is_refused_before_admission`。

## W4i 第五轮评审（`output/peer-atm3-w4i-r5.md`）：APPROVED

绑定 f60ce0e。无 P0、P1。R4-P1-01 的合法状态读回（含独立把读取恢复成 b3b0154 语义后 setup 读回用例变红）、R4-P2-01 的行为用例与 42 条变异的绑定都被确认；评审的沙箱建不了文件符号链接，那一条用例在那里是 SKIPPED，评审明确没有把它算作独立复现。结论限于 W4i 声明的范围，不替代正式宿主、完整安装 / 回滚与掉电验收。

留下一条非阻断的 P2，与 R4-P1-01 同一个根因（拼进 `app_dir_for` 之前没把 `legacy:` 分流出去），随后修掉，交给 W4 整体评审复核：

| 编号     | 问题                                                                                                                                                                       | 修订                                                                                                                                                                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R5-P2-01 | launcher 首次读 `app.json` 分流了 `legacy:`，但宿主不在、跑完 `--recover` 之后的再读没有：恢复把指针改成 `legacy:1.4.0` 时会拼出 `app-legacy:1.4.0\AyanamiTaskManager.exe` | `launcher` 的 `pointed`：读 `app.json`、分流 `legacy:`、拼宿主路径收在一处，首次读取与恢复后的再读都只走它；恢复后是 `legacy:` 时明确说已回到旧版，从旧版入口启动。launcher 自己那份 `LEGACY_PREFIX` 也改为引用 install-state 的，三处只有一个来源 |

- **用例**：`launcher` 的 `tests::a_legacy_pointer_never_becomes_a_host_path`（没有 `app.json`、`legacy:` 指针、普通版本、读不出来四种）。

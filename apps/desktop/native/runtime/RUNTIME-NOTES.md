# atm-runtime：3.x 无头运行时（W4i）

`atm-runtime` 是 ATM 3 单进程服务的运行时库：准入 → 启动判定 / 转换 → 权威判定 → 开放 Agent 入口 → 调度。
正式宿主（W6）链接这个库；`atm-runtime.exe` 是开发与端到端用例用的无头二进制，不进安装包。

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

## 进程内用例（`tests/boot.rs`、`tests/jobs.rs`）

- 入口顺序固定（lease → HTTP → daemon.json → 见证 → 调度器）；撤下后不再监听、daemon.json 不在。
- 源身份不符：阻塞比较判冲突，没有 lease 记录、HTTP、daemon.json、调度器。
- `A=legacy`：比较完才有入口；没动过 2.x 无损接回，动过就封存重转。
- 后台比较判冲突：先撤下全部入口，再写启动状态。
- 同一个 `N` 只有一个实例拿得到准入（F7）。
- sweep：客户端进程还在的 session 30 min 没心跳也不收，退出了的收（CLIENT_EXITED），没有身份的按普通超时。

## 不在 W4i

- 同步、派单与其余调度任务（W7）；冲突时它们本来就不起。
- 可信界面里的选源（W5/W6）：`Conflicted` 持有准入，等用户选。
- 旧版静止的进程映像判定：开发二进制只看 lease，正式宿主（W6）接入 setup 已有的判定。
- 安装与回滚全流程、掉电（W8）。

## 验红

`output/w4-evidence/mutations/mut-w4i.py`（runtime、store、state、http 四组），证据 `output/w4-evidence/w4i-*-mutation-evidence.json`。

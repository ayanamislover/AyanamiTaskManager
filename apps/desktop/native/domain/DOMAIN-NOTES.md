# atm-domain 说明

W2a（ATM-T-0590）。本 crate 只放「不读数据库」的规则：服务读出事实，交给这里判定，再按结果写入。
权威规格见 `output/atm3-spec/`，优先级为 10 > 00 > 01–11。

## 与规格字面不同的地方

| 位置                                | 规格                                                                  | 本 crate                                                                                                                                                 | 理由                                                                                                                                                                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `work::Operation::allowed_from`     | 01 W-020 另有 homomorphicFrom 表                                      | 不单列                                                                                                                                                   | 在 01 §2.2 的矩阵下，「目标等于当前、但当前不在同态表里」的情形不存在：release / complete / cancel 的目标都不在各自的起始集合里，reopen 的目标永远不等于当前。同态表与起始集合等价，留着它只会多出一个删掉也不变红的条件。逐格用例照样覆盖全部 `=` 格 |
| `work::WorkState`                   | 01 W-002 列出合法的 `(status, phase, waiting_on)` 组合                | 只存 `(phase, waiting_on)`，status 由两者推出                                                                                                            | 与 05 第 9 条（status 是生成列）一致；非法组合在类型上构造不出来                                                                                                                                                                                      |
| `work::Operation::guarded_by_claim` | 10 R1 举例列出 complete、cancel、verify、block、wait\_\*、ready、edit | 另含 reopen                                                                                                                                              | R1 的总原则是「凡是会修改已被领取任务的操作」。reopen 可以作用于有领取的 BLOCKED / WAITING / VERIFYING 任务                                                                                                                                           |
| `work::version_need`                | 11 P1-1 第 2 条                                                       | review_request、review_submit 也恒要版本                                                                                                                 | 两者的版本绑定本身就是语义（W-057、W-059）；11 只把状态类操作与 checklist\_\* 放宽                                                                                                                                                                    |
| `work::auto_start`                  | 11 P1-1 第 1 条                                                       | BLOCKED / WAITING\_\* 上只有「本来会被拒」的写入才提示 start                                                                                             | 状态机本来就放行的（BLOCKED 上的 block、从 BLOCKED 进入等待、从 WAITING 进入 verify）没有必要提示                                                                                                                                                     |
| `principal::Principal`              | 03 §2 写作 `Agent { session }`                                        | Agent 只带 A4 的连接组身份；解析好的 session 放在服务的 Actor 里                                                                                         | 03 §2.2 同时规定 session「由服务按输入解析并校验」；入口没有能力在构造主体时解析它                                                                                                                                                                    |
| `capability`                        | 03 §3 能力表                                                          | 另有 7 个只给 System 的内部能力：`store.cleanup`、`store.maintain`、`notify.send`、`sync.run`、`dispatch.track`、`agents.docs_install`、`memory.release` | 03 §2.4 的 job 表「允许的能力」一列提到了这些动作，但 §3 没有单列。快照用例（M-12）把它们固定下来                                                                                                                                                     |
| `capability::SettingsRead`          | 03 §3：「各 job 只读自己需要的 key」                                  | 授给 maintenance、notify.observe、update.check、sync.loop、dispatch.track、agents.repair                                                                 | key 级过滤在服务的设置读取里做                                                                                                                                                                                                                        |
| `keys::blocker_key`                 | 00 C-11 要求完成门给 `blocker_key`                                    | 格式 `{CODE}-B-{local_no:04}`                                                                                                                            | 2.x 没有 blocker 的公开 key，这是 v6 新增                                                                                                                                                                                                             |
| `gate::GateReason`                  | 00 C-11 只要求加 key                                                  | `CHILD_INCOMPLETE`、`DEPENDENCY_INCOMPLETE` 另带 `status`；后者再带 `cancelled`（C-29）                                                                  | 加字段是向后兼容的，Agent 不必再读一次就知道该怎么处理                                                                                                                                                                                                |
| `error::ErrorCode`                  | 03 §4.3、§4.4、P-008 提到但没有收进目录的码                           | 收入 `NOTIFICATION_MODE_INVALID`、`MCP_CLIENT_UNSUPPORTED`、`COMMAND_EXPIRED`、`RESULT_UNKNOWN`                                                          | 让目录成为唯一事实源。05 的 `OPERATION_REVOKED_BY_RESTORE` 已被 00 改名为 `OPERATION_UNDONE_BY_RESTORE`，不收                                                                                                                                         |

## 与 JS 逐字一致的部分

- `text::js_trim`：ECMAScript 的 WhiteSpace + LineTerminator。与 Rust `str::trim` 差 U+0085、U+FEFF 两个字符。
- `text::utf16_len`：zod 的字符串长度按 UTF-16 码元计数。
- `text::js_round`：`Math.round`，.5 取正无穷方向；不能写成 `(x + 0.5).floor()`（0.49999999999999994 会得到 1）。
- `time::Timestamp`：文本形式与 `Date.prototype.toISOString` 相同；解析时小数秒截到毫秒，与 `Date.parse` 一致。

## 主体构造的静态守卫

Rust 无法把函数的可见性限定到某几个 crate。`tests/principal_guard.rs` 扫描整个原生工作区：
`trusted_ui` 只能出现在 `ui-bridge`、`e2e-adapter`，`authenticated_agent` 只能出现在 `http`，
`verified_phone` 只能出现在 `sync`，`system_job` 只能出现在 `jobs`，以及各 crate 的 `tests/` 目录。
新建这些入口 crate 时要沿用这些目录名。

## 追溯

本 crate 只覆盖各条规则中「不读库」的部分；带 `W2c` / `W2d` 的部分在服务里实现并验收。

| 编号                                                 | 用例                                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| D01 状态机入口、同态、额外门                         | `work_matrix`：`every_cell_of_the_operation_state_matrix`（12 × 12 × 2 格）、`w020_*`、`w022_*`、`w097_*`；ready 无副作用：W2c |
| D02 等待保存 phase、reopen 目标                      | `work_matrix::w002_*`、矩阵的 `phase` 格                                                                                       |
| D03 依赖必须 DONE                                    | `gate::w093_w095_*`；claim / start 的 DEPENDENCY_NOT_READY：W2c                                                                |
| D04 占用、租约、takeover、successor reclaim、release | `ownership`：`w025_and_r2_acquire`、`w026_*`、`w028_c08_r2_release`、`c22_*`                                                   |
| D05、D06 完成门七谓词、汇总、上限、有效当前状态      | `gate`：`w090_*`～`w098_*`                                                                                                     |
| D07 verify_and_complete                              | `ergonomics`（自动补 start）、`gate::w096_w099_*`；单事务回滚：W2d                                                             |
| D09 批量创建                                         | `ergonomics::p1_5_and_c17_*`；其余：W2c                                                                                        |
| D10 版本                                             | `ergonomics::r11_version_*`；安全合并：W2c                                                                                     |
| D11、D12 检查项                                      | `gate::c10_*`、`gate::w053_w055_*`                                                                                             |
| D13、D16 Review 绑定与哈希                           | `evidence::w010_*`、`evidence::w059_*`                                                                                         |
| D14、D15                                             | W2d                                                                                                                            |
| D17 key 与证据                                       | `keys` 单测（`w001_*`、`w009_*`、`w012_*`、`c15_*`）、`evidence::w011_*`                                                       |
| D28 进度                                             | `progress`：`w110_*`～`w112_*`                                                                                                 |
| 00 C-02、C-23、C-24                                  | `progress::c02_*`、`c23_*`、`w110_done_*`                                                                                      |
| 00 C-07 / 10 R1                                      | `ownership::r1_may_modify`、`ergonomics::r1_claim_guard_*`                                                                     |
| 00 C-08、C-09 / 10 R2                                | `ownership::w028_*`、`r2_claim_follows_*`                                                                                      |
| 00 C-10、C-11、C-16、C-29                            | `gate::c10_*`、`w090_*`、`w093_w095_*`                                                                                         |
| 00 C-15、C-22                                        | `keys::c15_*`、`ownership::c22_*`                                                                                              |
| 00 C-17 / 10 R11 P1-5                                | `ergonomics::p1_5_and_c17_*`                                                                                                   |
| 10 R11 P1-1                                          | `ergonomics::r11_*`                                                                                                            |
| 11 §3 错误信封                                       | `errors`：2.x 目录逐码对照 `packages/errors/src/index.ts`、v6 新码、出路种类、信封形状                                         |
| 03 M-01、M-05、M-12、M-13、M-17、P-008、P-009、P-017 | `capability`                                                                                                                   |
| 03 P-001～P-003、M-03、M-04                          | `principal_guard`                                                                                                              |

变异验红：`output/w2-evidence/mutations/mut-domain.py`（执行器复用 W1 的 `mutrun.py`），
90 条变异全部 RED，证据在 `output/w2-evidence/domain-mutation-evidence.json`。

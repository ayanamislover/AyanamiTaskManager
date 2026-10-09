# ui-bridge：界面 API 的进程内分发（W5b / W5c）

React 界面不改读法：它照旧发 REST 形状的请求（`runtimeRequest({path, method, body})`），ui-bridge 在进程内按常量路由表分发，回 2.0 TS daemon 的原样形状。没有监听端口，没有 token。

## 路由表（W5b，06 §2、10 R8）

- `routes::UI_ROUTES` 共 67 条，是 06 §2 总表里处置为 U、U\*、A+U 的全部路由。唯一的例外是 #27 导出：它改成了只有 User 能调的 POST（00 C-07），客户端也随之改了。
- 投影健康面板的 #3、#4 在总表里标为「删」（00 §6），界面上的面板也一起删了。
- 匹配时字面段优先于参数段：`ui/work-items/closed` 不会落进 `ui/work-items/:taskKey`。
- `tests/routes.rs` 是守卫，核对两件事：
  - 这张表与总表一致；
  - 这张表与 `packages/client` 实际发出的调用一致。客户端里不走界面的调用都登记在 `NOT_UI`，并写明对应的 06 编号。

## 分发前的核对（10 R8）

下面的核对都在解析请求之前完成。没通过就不会碰到服务。

| 情况 | 应答 |
| --- | --- |
| 主体不是 User | 403 `USER_AUTHORIZATION_REQUIRED` |
| body 超过 2 MiB | 413 |
| 方法不在 GET/POST/PUT/PATCH/DELETE 里 | 405 |
| 目标不合格（见下） | 400 |
| 路径在表里、方法不对 | 405 |
| 路径不在表里 | 404 `NOT_FOUND` |
| 写请求的 body 不是 JSON 对象 | 400 |

目标的要求：

- 必须是 `/api/v1/` 下的相对路径。
- 长度不超过 4096 字节。
- 不能带片段 `#`。
- 不能有空段。
- 路径段解码后不能是 `.` 或 `..`，也不能含 `/`、`\`、NUL。
- 编码必须合格。

GET 与 DELETE 的 body 直接忽略。

`tests/r8.rs` 是这些核对的负例。

## User 主体

User 主体只在两处构造：

- 这里的 `webview(generation, epoch)` 与 `tray()`；
- e2e 适配器。

`domain/tests/principal_guard.rs` 守着这一点：`trusted_ui(` 只能出现在 ui-bridge、e2e-adapter 与测试里。

## 应答形状（W5c，06 T-COMPAT）

- 读：服务的 `atm_service::ui` 模块按 2.0 的 TS 形状组织应答。
  - 使用 camelCase，不做裁剪。
  - 数组是裸数组。
  - 分页是 `{items, nextCursor, hasMore}`。
- 写：凡是有 MCP 工具对应的（#55 建任务、#56 改任务、#76 写记录），都走 `atm_http::rest::call_tool_raw_as`。
  - 它与 Agent 入口共用同一份参数 schema 与同一个工具处理器（03 A6）。camelCase 字段按 schema 逐层改名，嵌套的 `checklist[].evidenceRequired` 也会处理。
  - 回给界面的不是 Agent 的 ACK，而是服务的原始写结果，从中挑出 2.0 界面路由回的那几个键。
  - 任务回执里的 `items` 是 hydrated WorkItemView，与界面列表用同一条 SQL。
- 错误用 2.0 信封：`{error: {code, message, retryable, details?}, request_id}`。

### 形状的守卫：`tests/compat.rs`

守卫由三份文件组成：

- `fixtures/ui-scenario.json`：两边共用的场景，59 个界面应答加 1 个 Agent 铺数据步骤。
- `fixtures/capture-2.0.ts`：在 2.0 daemon 进程内跑这份场景，把每一步的状态码、错误码与形状骨架录进 `fixtures/ui-shapes-2.0.json`。在仓库根目录运行：

  ```
  node node_modules/tsx/dist/cli.mjs apps/desktop/native/ui-bridge/tests/fixtures/capture-2.0.ts
  ```

- `compat.rs`：在 ui-bridge 上跑同一份场景，逐步比对：
  - 状态码相同；
  - 错误码相同；
  - 对象的键集合递归一致，叶子类型一致。某一边是 `null` 或空数组时不比类型。

比对有两条豁免：

- **`error.details` 不比。** 界面只读 code 与 message，`packages/ui` 与 `packages/client` 都不读 details。details 是给 Agent 的出路，3.0 按 02 §4 重做了。
- **有意去掉的键只有 `REMOVED` 里登记的几条。** 目前是 `projection`、`projectionSummary`、`projectionFailures`：3.0 是单库，没有投影（00 §6）。

### 场景暂不覆盖的界面路由

| 路由 | 原因 | 落在哪 |
| --- | --- | --- |
| #13 / #14 恢复请求的批准与拒绝 | 要先有 Agent 在垃圾箱项目的目录里 begin | 服务层的用例覆盖；e2e 在 W5d |
| #18 工程指标 | 采集与刷新在 W5h 才接上 | W5h |
| #24 备份恢复 | 3.0 要求指明范围 | `restore_scope` 的服务层用例 |
| #27 导出 | 导出在 W6 才有 | W6 |
| #88–#96 派单与手机同步 | 在 W7 之前回 404 `DISPATCH_UNAVAILABLE` / `SYNC_UNAVAILABLE` | W7 |

## 与 2.0 有意不同的地方

| 路由 | 3.0 的行为 | 依据 |
| --- | --- | --- |
| #24 备份恢复 | 必须带 scope：`PROJECT` 加 `project`，或 `KNOWLEDGE`。否则 422 `BACKUP_RESTORE_SCOPE_UNSUPPORTED` | 05 §2.7，整库备份 |
| #22 / #23 备份 | `scope` 是 `STORE`，`reason` 是备份的种类，没有单项目字段 | 方案 §4 |
| #1 状态 | 没有投影汇总。`projectCounts` 按生命周期给 `{total, failed: 0}`，因为单库没有逐库失败 | 00 §6 |
| #18 工程指标 | W5h 之前回 `{available: false, reason: "NOT_CAPTURED"}` | 方案 §10 |

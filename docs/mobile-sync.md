# 手机同步、自建中继与 Claude 自动派单

状态：设计定稿（2026-09-30），实现跟踪 ATM EPIC「手机端 ATM 与自建中继同步」。决策理由见
[ADR-016](adr/ADR-016-mobile-relay-and-dispatch.md)。

## 1. 目标与边界

- 手机上看电脑里的项目与任务（只读镜像），并能**发任务上来**。
- 手机发来的任务可以勾选「交给 Claude」：电脑收到后自动拉起一个 Claude Code 会话，
  领取任务、完善目标（改写描述、补验收标准、必要时拆子任务）并开工。
- 通信像 RustDesk 一样**服务器由用户自己配置**。仓库和安装包里**没有任何默认服务器地址**；
  开源用户自建 `atm-relay`，维护者自己的实例可以直接用 AyanamiCloud 的「应用数据」接口。
- 中继是**不可信传输层**：所有载荷端到端加密，中继只看到密文、键名和时间。
- ATM daemon **不新开任何监听端口**，同步连接器只做出站 HTTPS。
- 默认关闭。不配置中继时，ATM 与以前完全一样，是纯本地工具。

不做：多用户、手机端改写任务内容、手机端直接跑 Agent、推送通知（第一版前台轮询）。

## 2. 组件

```text
 手机 App (apps/mobile)                 中继（二选一）                     电脑
 ┌──────────────────────┐   HTTPS   ┌──────────────────────────┐  HTTPS  ┌──────────────────────────┐
 │ React + Capacitor 8   │ ────────▶ │ atm-relay (apps/relay)    │ ◀────── │ 同步连接器 packages/sync  │
 │ sync-protocol 客户端   │           │  或 AyanamiCloud 应用数据  │         │  └ 在 daemon 进程内运行   │
 │ 本地缓存 + 安全存储     │           │  （同一套 HTTP 子集）      │         │ Claude 派单 agent-dispatch│
 └──────────────────────┘           └──────────────────────────┘         └──────────────────────────┘
```

| 包                        | 作用                                                                                       | workspace 依赖                                 |
| ------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `packages/sync-protocol`  | 同构（Node / WebView）：文档键、加密信封、分片、配对码、命令/快照 schema、中继 HTTP 客户端 | 无                                             |
| `packages/sync`           | 电脑侧连接器：配置与密钥、快照发布、命令处理、在线状态                                     | application、errors、protocol、sync-protocol   |
| `packages/agent-dispatch` | Claude Code 无头派单：排队、并发、进程、日志、历史                                         | agent-config、errors                           |
| `apps/relay`              | 可自建中继，零第三方依赖（`node:http` + `node:sqlite`），附 Dockerfile                     | 无                                             |
| `apps/mobile`             | 手机 App（Vite + React + Capacitor 8，资源打包进 APK）                                     | protocol、sync-protocol、ui（仅 `tokens.css`） |

## 3. 传输层：应用数据 HTTP 子集

客户端只用下面 6 个接口。它们与 AyanamiCloud 契约 0.5.x 的 `/v1/apps/{app}/…` **逐字段兼容**，
`atm-relay` 是这个子集的一份独立实现（clean-room，AGPL）。

所有请求带 `Authorization: Bearer <token>`、`Accept: application/json`。
错误体统一为 `{"error":{"code":"SCREAMING_SNAKE","message":"…","retry_after"?:秒}}`。

| 方法   | 路径                                                 | 说明                                                                                                                                    |
| ------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/apps/{app}`                                     | 连接测试。200 且 `id == app` 即可用。`atm-relay` 额外返回 `relay: {name:"atm-relay", version, long_poll: true, max_wait: 25}`           |
| GET    | `/v1/apps/{app}/documents?prefix=&cursor=&limit=`    | 列文档元数据 `{documents:[DocumentMeta], next_cursor}`，limit 默认 100、上限 500                                                        |
| GET    | `/v1/apps/{app}/documents/{key}`                     | 读 `Document`（= DocumentMeta + `data`），不存在 404 `NOT_FOUND`                                                                        |
| PUT    | `/v1/apps/{app}/documents/{key}`                     | 体 `{expected_revision, data, schema_version?}`；0 表示新建；成功 201（新建）/200；修订号不符 409 `REVISION_CONFLICT`，响应带 `current` |
| DELETE | `/v1/apps/{app}/documents/{key}?expected_revision=N` | 204；不符 409；不存在 404                                                                                                               |
| GET    | `/v1/apps/{app}/changes?cursor=&limit=&wait=`        | `{changes:[Change], next_cursor, has_more}`；游标过期 410 `CURSOR_EXPIRED`                                                              |

- `{key}` 满足 `^[A-Za-z0-9_./-]{1,200}$`，路径里斜杠必须编码成 `%2F`。
- `DocumentMeta = {key, schema_version, revision, updated_at, updated_by_device, size_bytes}`。
- `Change = {seq, key, revision, op: "put"|"delete", device_id, at}`。
- 同一个键的修订号**跨删除单调递增**（防 ABA）；新建时客户端以响应里的 `revision` 为准。
- 单文档 `data` 序列化后 ≤ 256 KiB（本协议自己把每片控制在 160 KiB 以内）。
- `wait`（秒，≤ 25）是 `atm-relay` 的扩展：没有新变更时挂起到有变更或超时。
  AyanamiCloud 忽略这个参数、立即返回，客户端据 `GET /v1/apps/{app}` 里有没有 `relay.long_poll`
  决定用长轮询还是定时轮询（电脑 4 s、手机前台 3 s，后台不轮询）。
- 首次同步（没有游标）：先沿 `changes` 从空游标翻到 `has_more=false` 拿到头部游标，
  再 `documents?prefix=atm1/<space>/` 全量列一遍。410 时同样重来一次。

## 4. 空间、密钥与加密

**配对空间（space）**：一台电脑一个。`spaceId` = 12 个随机字节的小写 hex（24 位）。
所有文档键都以 `atm1/<spaceId>/` 开头，所以同一个中继 app 可以容纳多台电脑。

**空间密钥**：32 个随机字节 `secret`，只存在电脑（加密落盘）和已配对手机（Android Keystore 加密）里。

```text
salt      = UTF-8("atm-sync/v1")
aeadKey   = HKDF-SHA256(secret, salt, info="aead",  32 字节)  → AES-256-GCM
nameKey   = HKDF-SHA256(secret, salt, info="names", 32 字节)  → HMAC-SHA256
kid       = hex(HMAC(nameKey, "kid"))[0:8]                    用来识别配错密钥
projectH  = hex(HMAC(nameKey, "project:" + CODE))[0:20]        项目码不出现在键名里
```

**加密信封**（存为文档的 `data`）：

```json
{
  "v": 1,
  "kid": "a1b2c3d4",
  "iv": "<b64url 12B>",
  "z": 1,
  "n": 1,
  "d": "<16 hex>",
  "c": "<b64url 密文>"
}
```

- 明文 = UTF-8 JSON；超过 1 KiB 先 `deflateRaw`（fflate）并置 `z:1`。
- AAD = UTF-8(逻辑键)。中继把 A 文档的密文挪到 B 键下会解密失败。
- `d` = hex(SHA-256(完整密文))[0:16]；`n` = 分片数。
- 密文 base64url 后超过 160 000 字符时分片：第 0 片放在逻辑键本身（带 `v/kid/iv/z/n/d/c`），
  第 i 片放在 `<逻辑键>.<i>`，内容 `{ "v":1, "d":"…", "i":i, "c":"…" }`。
  写入顺序：先写 1..n-1 片，最后写第 0 片（第 0 片是提交点），再删掉多余的旧片。
  读取：读第 0 片 → 读其余各片 → 任何一片的 `d` 不一致就视为写入进行中，稍后重读。
- `kid` 不符 → 提示「配对密钥已更换，请重新配对」，不重试。

**配对码**：`atm1:` + base64url(UTF-8 JSON)，二维码内容与之相同。

```json
{
  "v": 1,
  "u": "https://relay.example.com",
  "a": "atm",
  "t": "<中继 token>",
  "s": "<spaceId>",
  "k": "<b64url secret>",
  "n": "电脑名"
}
```

配对码里有中继 token 和空间密钥，只在电脑端「手机同步」面板上显示，不写日志、不进 ATM 记录。
「重置配对」会生成新的 `spaceId` 和 `secret`，并删除旧空间里的全部文档（含手机写的）；旧手机随即失效，需要重新扫码。
吊销中继 token 属于中继自己的管理动作（`atm-relay token revoke` 或 AyanamiCloud 网页）。

## 5. 文档键

以下 `<S>` = `atm1/<spaceId>`，内容都是加密信封里的明文 JSON，`v` 固定为 1。

| 键                   | 写入方 | 内容                                                                                                  |
| -------------------- | ------ | ----------------------------------------------------------------------------------------------------- |
| `<S>/head`           | 电脑   | `{v, host:{id,name,app}, at, dispatch:{enabled, mode, running}, projects:[ProjectHead]}`              |
| `<S>/p/<projectH>`   | 电脑   | `{v, code, name, at, tasks:[TaskCard]}`                                                               |
| `<S>/cmd/<cmdId>`    | 手机   | `{v, id, device:{id,name}, at, type, body}`                                                           |
| `<S>/ack/<cmdId>`    | 电脑   | `{v, id, at, ok:true, result} \| {v, id, at, ok:false, error:{code,message}}`                         |
| `<S>/dev/<deviceId>` | 各设备 | `{v, id, name, kind:"windows"\|"android", role:"host"\|"client", app, at, state:"online"\|"offline"}` |

```ts
type ProjectHead = {
  code: string;
  name: string;
  h: string;
  d: string; // d = 项目文档内容摘要，变了才重写
  counts: {
    active: number;
    ready: number;
    inProgress: number;
    blocked: number;
    waitingUser: number;
    doneRecent: number;
  };
  updatedAt: string;
};
type TaskCard = {
  key: string;
  title: string;
  type: string;
  status: string;
  priority: string;
  progress: number;
  parent?: string;
  updatedAt: string;
  claim?: { agent: string; since?: string };
  waiting?: string;
  blocked?: string;
  // 以下只给未关闭任务
  desc?: string; // ≤ 2000 字符
  acceptance?: string[]; // ≤ 12 条
  checklist?: { done: number; total: number };
  recent?: Array<{ at: string; summary: string; percent?: number }>; // ≤ 3 条
  dispatch?: {
    state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    at: string;
    run: string;
  };
};
```

- 项目文档包含全部未关闭任务，加上最近 14 天内关闭的至多 30 个（不带详情字段）。
- `cmdId` = `<deviceId>.<13 位 base36 毫秒时间><8 位随机 hex>`，全局唯一，也用作 ATM 的 `op_id`（`mobile:<cmdId>`），
  所以同一条命令被处理两次也只建一个任务。
- 电脑处理完命令：先写 `ack`，再删 `cmd`。手机看到 `ack` 后删掉它；电脑每天清一次 7 天前的 `ack`。
- 在线状态：电脑启动、每 5 分钟、正常退出（`state:"offline"`）各写一次。手机据 `at` 在 7 分钟内判定「电脑在线」。

## 6. 命令

| type            | body                                                            | 电脑侧动作                                                                                                                                                                                                                                                                                                        |
| --------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task.create`   | `{project, title, description?, priority?, dispatch?: boolean}` | 以 USER 身份建任务：挂到该项目第一个 ACTIVE 目标（没有就按 promote 的规则补建一个「自动补建」目标）、状态 READY、`op_id = mobile:<cmdId>`；`dispatch` 为真且派单已开启时随即排队派单。结果 `{project, key, dispatch?: {run, state}, dispatchError?: {code, message}}`（任务已建好但派单被拒时给 `dispatchError`） |
| `task.dispatch` | `{project, key}`                                                | 对已有任务排队派单。任务必须是 READY 或 BACKLOG 且没有有效领取                                                                                                                                                                                                                                                    |

校验失败、项目不存在、任务不存在、命令过期等写 `ok:false` 的 ack；任务已建好但派单被拒（例如派单未开启）写 `ok:true` 并带 `dispatchError`，错误码见实现里的 `SyncCommandError`。
`title` 1–200 字符，`description` ≤ 8000 字符，`priority ∈ LOW|NORMAL|HIGH|CRITICAL`（默认 NORMAL）。
命令 `at` 早于 7 天的直接拒绝（`COMMAND_EXPIRED`）。

## 7. 电脑侧连接器（packages/sync）

- 运行在 daemon 所在进程（当前是 Electron 主进程），直接调用 `AyanamiTaskService`，不走 HTTP。
- 非敏感配置 `<数据目录>/sync/config.json`：`enabled、relayUrl、appId、deviceId、deviceName、spaceId、cursor`
  和每个项目最近一次发布的摘要。敏感项（中继 token、空间 secret）经宿主提供的 `SecretStore` 落盘：
  桌面端用 Electron `safeStorage`（DPAPI），落在 `sync/secrets.enc.json`，`safeStorage` 不可用时拒绝保存；
  独立 daemon（开发 / e2e，需设 `ATM_SYNC=1` 才创建连接器）用明文 `sync/secrets.json` 并在状态里标注。
  **两者都不进 Registry 的 settings 表**（那张表 Agent 令牌可读）。
- 启用且地址、app、token 齐全时自动建空间；并发请求配对码也只会建一次（单飞）。
  换中继地址或 app、重置配对时清空游标、已发布摘要与修订号缓存，走一次全量重同步。
- 快照：订阅进程内全局事件，把受影响项目标脏，1.5 s 去抖后重建该项目的 `TaskCard` 列表；摘要不变就不写。
  启动时全量发布一次。
- 命令：变更流里出现 `<S>/cmd/*` 的 put 就读、解密、校验、执行、回 ack；启动时再 `documents?prefix=<S>/cmd/` 兜底一次。
- 退避：网络错误 1 s → 2 s → … → 60 s；401/403 停止并在状态里显示「中继拒绝了 token」；410 走全量重同步；
  `changes` 回 400（多半是换了中继、拿着对方格式的游标）清游标重来一次，再失败才报错；429 按 `retry_after` 等待。

### REST（daemon，供桌面设置页用）

宿主没有注入连接器 / 派单器时，对应路由统一返回 404 `SYNC_UNAVAILABLE` / `DISPATCH_UNAVAILABLE`（路由总是注册，权限守卫才能覆盖到）。
`state ∈ disabled | connecting | online | error`，细分原因写在 `lastError`（中文）；`paired` 每项是设备文档去掉 `v`，只列其它设备；
`configured` 表示地址、app、token 三者齐备；`secretStore ∈ safeStorage | plaintext`。

| 方法 | 路径                                                 | 权限      | 说明                                                                                                                                                                     |
| ---- | ---------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET  | `/api/v1/sync/status`                                | 两种令牌  | 状态，**不含任何密钥**：`{enabled, configured, relayUrl, appId, deviceName, state, lastError, lastSyncAt, longPoll, secretStore, paired: DeviceView[], pendingCommands}` |
| PUT  | `/api/v1/sync/config`                                | USER_ONLY | `{enabled?, relayUrl?, appId?, token?, deviceName?}`；`token` 只写不读，传空字符串表示清除                                                                               |
| POST | `/api/v1/sync/test`                                  | USER_ONLY | 用给定或已存配置探测中继：`{ok, latencyMs, longPoll, server?, error?}`                                                                                                   |
| POST | `/api/v1/sync/pairing`                               | USER_ONLY | 返回 `{pairingCode, spaceId}`；没有空间时先创建                                                                                                                          |
| POST | `/api/v1/sync/reset`                                 | USER_ONLY | 轮换空间（旧手机失效）                                                                                                                                                   |
| GET  | `/api/v1/dispatch/status`                            | 两种令牌  | `{enabled, permissionMode, maxConcurrent, model, effort, claude:{found, path, version?}, runs: DispatchRunView[]}`                                                       |
| PUT  | `/api/v1/dispatch/config`                            | USER_ONLY | `{enabled?, permissionMode?, maxConcurrent?, model?, effort?}`                                                                                                           |
| POST | `/api/v1/projects/:code/ui/work-items/:key/dispatch` | USER_ONLY | 桌面端「交给 Claude」按钮                                                                                                                                                |
| POST | `/api/v1/dispatch/runs/:run/cancel`                  | USER_ONLY | 结束一次派单                                                                                                                                                             |

## 8. Claude 自动派单（packages/agent-dispatch）

- 默认关闭；开启后只处理**用户明确要求**的任务（手机勾选「交给 Claude」或桌面按钮），从不自己挑任务。
- 工作目录 = 项目的主路径（`project_paths` 里 `is_primary` 优先）。项目没有绑定路径则拒绝并说明。
- 命令行（参数数组，不经 shell）：

  ```text
  claude -p <提示词> --permission-mode <auto|acceptEdits|bypassPermissions|plan>
         --output-format stream-json --verbose --session-id <uuid> --name "ATM · <任务键>"
         [--model <model>] [--effort <level>]
  ```

  `claude` 可执行文件复用 `agent-config` 的 `findClaudeCodeCli()` 定位。默认权限模式 `auto`，并发上限默认 1。

- 提示词要求会话：`atm_begin` → 领取并开工指定任务（已被别人领取就结束）→ 读代码与 ATM 记录，
  用 `atm_task_patch edit` 改写描述、补齐验收标准，必要时拆子任务 → 开始实现，按 ATM 规则写进度 →
  需要用户决定时置为 WAITING_USER 并写清问题 → `atm_end` 交接。
- 进程 `detached`、`windowsHide`，stdout 逐行写 `<数据目录>/dispatch/logs/<run>.jsonl`；
  历史（最近 50 次）写 `<数据目录>/dispatch/runs.json`。宿主退出不杀会话；重启后把残留的 running 按 PID 存活与否修正。
- 会话 ID 固定且会持久化：事后可以在电脑上 `claude -r <session-id>` 接着和这个会话对话。
- 派单状态随快照出现在手机任务卡片上；任务本身的进度来自 Claude 写进 ATM 的 progress。

## 9. 手机 App（apps/mobile）

- 应用 ID `moe.ayanami.atm`，minSdk 29、targetSdk 36；网页资源打包进 APK（不加载远程网页）。
- 视觉沿用桌面端 `packages/ui/src/tokens.css` 的二次元柔彩（浅/深两套），组件为手机重新实现：
  触控目标 ≥ 44px、自绘下拉、单焦点环（`field-shell`）。edge-to-edge：状态栏与导航栏高度由原生量出后交给网页留边
  （WebView 151 的 `env(safe-area-inset-*)` 不可靠），键盘与刘海仍由原生留边；深浅色由原生注入（`prefers-color-scheme` 在该 WebView 里恒为浅色）。
- 请求走 Capacitor 原生 HTTP（`CapacitorHttp`），不受中继 CORS 限制。
- 配对信息（中继 token、空间 secret）存在由 Android Keystore 加密的原生存储里；快照缓存存 IndexedDB，离线可看。
- 屏幕：配对（扫码 / 粘贴配对码）→ 总览（电脑在线状态、项目卡片）→ 项目（按状态分组的任务）→
  任务详情（目标、验收、清单、最近进度、派单状态、「交给 Claude」）→ 新任务（项目、标题、目标描述、优先级、交给 Claude）→ 设置。
- 发出的命令在本地排队显示「等待电脑接收」，收到 ack 后变成「已创建 ATM-T-xxxx」。
- 开发联调：`adb reverse tcp:8790 tcp:8790` 后手机用 `http://127.0.0.1:8790` 连电脑上的 `atm-relay`；
  明文 http 只允许 `127.0.0.1` / `localhost`，其余地址必须 https。

## 10. 自建中继（apps/relay）

```text
node atm-relay.mjs serve --data ./relay-data --listen 0.0.0.0:8790 [--tls-cert … --tls-key …]
node atm-relay.mjs token create --label 我的手机     # 明文只打印一次
node atm-relay.mjs token list | token revoke <id>
```

- 首次启动自动建 app `atm`，并把第一枚 token 写进 `<data>/initial-token.txt`（0600），日志里只打印这个路径。
- 服务端只存 token 的 SHA-256；文档与变更存 `node:sqlite`。变更保留 30 天或 10 000 条，超出后游标 410。
- 限额：请求体 300 KiB、每 app 5000 个文档、200 MiB；每 token 20 req/s；长轮询每 token 4 个、全局 256 个。
- 建议放在 Caddy / Nginx / Cloudflare Tunnel 后面提供 HTTPS；也可以直接给证书文件。
- `docker build -f apps/relay/Dockerfile .` 得到只含 Node 运行时和单文件的镜像。

## 11. 接入 AyanamiCloud（维护者自用）

在 AyanamiCloud 网页「应用」里登记 app（id 建议 `atm`），签一枚 token，然后在 ATM 设置「手机同步」里
填服务器地址、app id 和 token。AyanamiCloud 不支持长轮询，电脑每 4 秒、手机前台每 3 秒轮询一次。
ATM 仓库不内置这个地址，也不引用它。

## 12. 威胁模型摘要

| 攻击者                           | 能做到                                              | 做不到                                                              |
| -------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------- |
| 中继运营者 / 拿到中继 token 的人 | 看到键名、大小、时间；删改或重放密文；拒绝服务      | 读内容；伪造命令（没有空间密钥过不了 GCM）；把文档挪到别的键（AAD） |
| 拿到手机的人                     | 用已配对手机看任务、发任务（和本人一样）            | 在电脑上做白名单以外的任何操作                                      |
| 本机其它 Agent                   | 读 `/api/v1/sync/status`、`/api/v1/dispatch/status` | 拿配对码、token、secret；改同步或派单配置（USER_ONLY）              |

重放：命令 ID 唯一且作为幂等键，重放同一条命令不会建第二个任务；过期命令被拒。

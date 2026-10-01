# atm-relay：手机同步的自建中继

AyanamiTaskManager（ATM）的手机同步不在电脑上开任何端口：电脑和手机都**出站**连接一个你自己部署的中继，
在上面交换加密过的文档。`atm-relay` 就是这个中继：

- 一个文件（`atm-relay.mjs`），只用 Node.js 内置模块（`node:http`、`node:sqlite`、`node:crypto`），**零第三方依赖**；
- 实现 AyanamiCloud「应用数据」接口的一个子集（6 个接口，逐字段兼容，见文末「兼容性」），另加 25 秒长轮询；
- **只见密文**：载荷在电脑和手机之间端到端加密，中继只看得到键名、大小和时间。

设计背景见仓库里的 `docs/mobile-sync.md` §3、§10、§12 与 `docs/adr/ADR-016-mobile-relay-and-dispatch.md`。

## 直接运行

需要 Node.js ≥ 22.13（`node:sqlite` 从这个版本起无需开关）。

```bash
# 在仓库里构建出单文件 apps/relay/dist/atm-relay.mjs
pnpm --filter @ayanami-task/relay build

# 这个文件可以拷到任何装了 Node 的机器上单独运行
node atm-relay.mjs serve --data ./relay-data --listen 0.0.0.0:8790
```

首次启动会建立应用 `atm`、签发第一枚 token，把明文写进 `./relay-data/initial-token.txt`
（POSIX 下权限 0600；Windows 下去掉继承、只授当前用户）。日志里只打印这个文件的路径。
把 token 填进 ATM 桌面端「手机同步」设置后，**删掉这个文件**。

`--listen` 默认是 `127.0.0.1:8790`（只接受本机连接），对局域网或反向代理开放时用 `0.0.0.0:8790`。
也可以直接提供证书：`--tls-cert fullchain.pem --tls-key privkey.pem`，续期后发 `SIGHUP` 重新加载。

`SIGINT` / `SIGTERM` 会先让挂起的长轮询立即返回、再关库退出；客户端下一轮会自动重连。

## Docker

在**仓库根**构建（构建上下文由 `apps/relay/Dockerfile.dockerignore` 限定为中继自己的源码，需要 BuildKit）：

```bash
docker build -f apps/relay/Dockerfile -t atm-relay .
docker run -d --name atm-relay --restart unless-stopped \
  -p 127.0.0.1:8790:8790 -v atm-relay-data:/data atm-relay
docker exec atm-relay cat /data/initial-token.txt     # 抄走 token
docker exec atm-relay rm /data/initial-token.txt
```

镜像基于 `node:24-alpine`，只含 Node 运行时与 `atm-relay.mjs`（包管理器已删掉），以非 root 用户 `node` 运行，
数据卷 `/data`，端口 8790，自带 `HEALTHCHECK`（访问 `/health/live`；如果在容器里直接启用 TLS，需要把检查改成 https）。

## 放在 HTTPS 反向代理后面（推荐）

手机只允许对 `127.0.0.1` / `localhost` 用明文 http，其余地址必须 https。最省事的做法是让中继只监听本机，
由反向代理负责证书。下面的域名都是示例，换成你自己的。

**Caddy**（自动申请证书）：

```caddyfile
relay.example.com {
	reverse_proxy 127.0.0.1:8790
}
```

**Nginx**：长轮询最长挂 25 秒，`proxy_read_timeout` 要大于它（默认 60 秒就够）；不要对 `/v1/` 开 `proxy_cache`
（响应本身都带 `Cache-Control: no-store`）。

**Cloudflare Tunnel**：

```yaml
# ~/.cloudflared/config.yml
tunnel: <你的 tunnel ID>
credentials-file: /root/.cloudflared/<你的 tunnel ID>.json
ingress:
  - hostname: relay.example.com
    service: http://127.0.0.1:8790
  - service: http_status:404
```

放在代理后面时加上 `--trust-proxy`：中继会用 `X-Forwarded-For` 最右一段作为**未认证请求**的限流键
（已认证的请求一律按 token 限流）。它不参与任何认证判断。没有代理时不要打开，否则客户端能伪造来源换桶。

## token 管理

```bash
atm-relay token create --label 我的手机 --data ./relay-data   # 明文只打印这一次（stdout 只有明文一行）
atm-relay token list --data ./relay-data                       # ID、标签、前缀、最近使用、是否撤销；--json 可机读
atm-relay token revoke tok_xxxxxxxxxxxxxxxx --data ./relay-data
atm-relay app list --data ./relay-data
atm-relay app create other-app --name 另一个应用 --data ./relay-data
```

- token 形如 `atr_<8 位前缀>_<32 位随机>`（约 160 位熵），服务端只存 SHA-256；`token list` 里的前缀用来辨认是哪一枚。
- `--data` 也可以用环境变量 `ATM_RELAY_DATA` 代替（Docker 镜像里已经设成 `/data`）。
- 管理命令可以在 `serve` 运行时执行（同一个库，WAL 模式）；撤销**立即生效**，服务端不缓存 token。
- 一枚 token 只能访问它所属的应用。ATM 的一台电脑与它配对的手机共用同一枚 token（写在配对码里）；
  换手机、丢手机时：撤销旧 token → 签一枚新的 → 在桌面端「手机同步」里换上并重新配对。

## 备份与恢复

数据全在数据目录里：`relay.db`（外加运行时的 `relay.db-wal`、`relay.db-shm`）。

- 最简单：停掉中继 → 复制整个数据目录 → 启动。
- 不停机：装了 `sqlite3` 命令行时 `sqlite3 relay.db ".backup relay-backup.db"`。
- 中继只存密文，而且内容都能重建：电脑每次启动都会全量重新发布快照。真正会丢的只有「手机发出、电脑还没收到」的命令。
- 从较旧的备份恢复后，客户端手里的游标会比库里新；中继对这种「来自未来的游标」回 `410 CURSOR_EXPIRED`，
  客户端自动全量重同步，不会停在一个永远等不到的位置。
- **升级**：新版第一次打开旧数据目录时自动迁移库结构（同一个事务里完成，失败则原样回滚）。迁移之后旧版 `atm-relay`
  会拒绝打开这个库（「由更新版本的 atm-relay 创建」），所以升级前先停掉旧版 `serve`、做一次备份。
  库版本 2 删掉了 v1 里为每个出现过的键永久保留的修订号高水位表，换成每个应用一行的修订号地板（见「限额」下的磁盘占用说明）；
  释放出的页由 SQLite 复用，想让文件立刻变小可在停机时执行 `sqlite3 relay.db VACUUM`。

## 限额

默认值按「一台电脑 + 几部手机」的个人用量定，全部可用环境变量覆盖（必须是正整数，写错会直接拒绝启动）：

| 项目                                  | 默认     | 环境变量                             | 超限时                             |
| ------------------------------------- | -------- | ------------------------------------ | ---------------------------------- |
| 请求体                                | 300 KiB  | `ATM_RELAY_MAX_BODY_BYTES`           | 413 `PAYLOAD_TOO_LARGE`            |
| 单文档 `data`（原文字节）             | 256 KiB  | `ATM_RELAY_MAX_DATA_BYTES`           | 413 `PAYLOAD_TOO_LARGE`            |
| 每应用文档数                          | 5000     | `ATM_RELAY_MAX_DOCUMENTS`            | 507 `INSUFFICIENT_STORAGE`         |
| 每应用总字节                          | 200 MiB  | `ATM_RELAY_MAX_APP_BYTES`            | 507 `INSUFFICIENT_STORAGE`         |
| 每 token 请求速率（令牌桶，容量同值） | 50 次/秒 | `ATM_RELAY_RATE_PER_SECOND`          | 429 `RATE_LIMITED` + `retry_after` |
| 每 token 同时挂起的长轮询             | 4        | `ATM_RELAY_WAITERS_PER_TOKEN`        | 429 `TOO_MANY_WAITERS`             |
| 全局同时挂起的长轮询                  | 256      | `ATM_RELAY_WAITERS_GLOBAL`           | 429 `TOO_MANY_WAITERS`             |
| 长轮询最长等待                        | 25 秒    | `ATM_RELAY_MAX_WAIT_SECONDS`（≤ 60） | 超过按上限处理                     |
| 每应用保留的变更条数                  | 10 000   | `ATM_RELAY_CHANGE_RETENTION`         | 旧游标 410 `CURSOR_EXPIRED`        |
| 变更保留天数                          | 30       | `ATM_RELAY_CHANGE_RETENTION_DAYS`    | 旧游标 410 `CURSOR_EXPIRED`        |

未认证请求（没带或带错 token）按来源地址走同样的令牌桶，乱试 token 很快会被 429 挡住。
429 的响应同时带 `Retry-After` 头和错误体里的 `retry_after`（秒）。

**磁盘占用有界。** 数据接口能写到的只有三样，每个应用都有上限：现存文档（受文档数与总字节限额约束）、
变更流（按上面两条保留规则裁剪，至多「保留条数」行）、一行修订号地板。删除文档不留墓碑：
一枚泄露的 token 在限速内反复「建新键 → 删掉」，库里的行数也不会超过「文档数上限 + 变更保留条数 + 1」。
防 ABA 靠的是这一行地板，不是逐键记录，见下文「兼容性」里的修订号说明。

## 接口

所有请求带 `Authorization: Bearer <token>`。错误体统一为 `{"error":{"code":"…","message":"…","retry_after"?:秒}}`。

| 方法   | 路径                                                 | 说明                                                                                                  |
| ------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| GET    | `/v1/apps/{app}`                                     | 应用详情（AyanamiCloud 的 `AppDetail` 全部字段）+ `relay: {name, version, long_poll: true, max_wait}` |
| GET    | `/v1/apps/{app}/documents?prefix=&cursor=&limit=`    | `{documents: DocumentMeta[], next_cursor}`，按键排序，limit 默认 100、上限 500                        |
| GET    | `/v1/apps/{app}/documents/{key}`                     | `Document`；不存在 404 `NOT_FOUND`                                                                    |
| PUT    | `/v1/apps/{app}/documents/{key}`                     | 体 `{expected_revision, data, schema_version?, device_id?}`；新建 201 / 更新 200；不符 409            |
| DELETE | `/v1/apps/{app}/documents/{key}?expected_revision=N` | 204；不符 409；不存在 404                                                                             |
| GET    | `/v1/apps/{app}/changes?cursor=&limit=&wait=`        | `{changes, next_cursor, has_more}`；`wait`（秒，≤ 25）为长轮询扩展                                    |
| GET    | `/health/live`                                       | `{"ok":true}`，不需要 token                                                                           |

CORS：任何来源都放行（`Access-Control-Allow-Origin: *`，允许 `Authorization`、`Content-Type` 头与
GET/PUT/DELETE/OPTIONS），但不放行 Cookie。token 不是浏览器自动附带的凭据，别的网页拿不到它，所以没有 CSRF 面。

## 兼容性

`atm-relay` 按 AyanamiCloud 的公开接口契约（`/v1/apps/{app}/…` 应用数据部分）独立实现，没有复制其代码。
下面各条除标注「按源码确认」的以外，都在两边实测过：同一套客户端契约（`test/contract/app-data-contract.ts`）在 vitest 里对 atm-relay 跑，
并用 `scripts/contract-against.ts` 对本机从源码构建的 AyanamiCloud 测试实例（127.0.0.1）跑。

**实测结果（2026-09-30）**：AyanamiCloud 21 条用例通过 19、跳过 2（两条长轮询用例，它不支持），失败 0；
其中「游标被裁剪 → 410」用例按它的保留条数 10000 实写了 10002 次。atm-relay 通过 20、跳过 1（「服务端忽略 wait」，它支持长轮询）。

逐条确认一致的行为：

- **认证与归属**：没带 token、token 错误或已撤销（撤销一项按源码确认）→ 401 `UNAUTHORIZED`；token 有效但路径里的 app 不是它的（包括不存在的 app）→ 403 `FORBIDDEN`。
  `Authorization` 的 `Bearer` 大小写不敏感。
- **错误体**：`{"error":{"code","message"}}`，409 的附加字段（`current`、`conflict_id`）平铺在 `error` 的同一层。
- **Document / DocumentMeta 字段**：`key, schema_version, revision, updated_at, updated_by_device, size_bytes`（+ `data`），
  时间是 RFC 3339 UTC 毫秒（`2026-09-30T12:00:00.000Z`）。
- **PUT**：`expected_revision=0` 表示新建，成功 201；更新 200、修订号 +1。`schema_version` 缺省或 ≤ 0 时为 1（每次写都按本次请求取值）。
  请求体读不懂（坏 JSON、不是对象、`expected_revision` 不是整数字面量如 `"0"`/`1.0`）→ 400 `BAD_REQUEST`；
  缺 `expected_revision`、缺 `data`、修订号为负 → 400 `INVALID_ARGUMENT`；`data` 原文超过 256 KiB → 413 `PAYLOAD_TOO_LARGE`（恰好 256 KiB 可写）。
- **PUT 409**：修订号不符（包括对已存在的键用 0、对不存在的键用非 0）→ 409 `REVISION_CONFLICT`，
  顶层带 `current`（当前文档，不存在时为 `null`）和 `conflict_id`（null）。
- **DELETE**：必须带 `expected_revision` 查询参数，缺了或不是非负整数 → 400 `INVALID_ARGUMENT`；不符 → 409，顶层只带 `current`；
  不存在 → 404 `NOT_FOUND`；成功 204 空体。
- **修订号跨删除单调递增**（防 ABA）：删除消耗一个修订号（变更流里 delete 的 `revision` = 删除前 + 1）；
  删掉再建的键，新修订号严格大于它以前用过的全部修订号，拿着旧修订号（包括删除用掉的那个）的条件写一律 409。
  新建时的起点两边不同，见下表「新建的修订号」。atm-relay 另外验证了这条保证跨进程重启、跨库版本迁移都成立。
- **键**：解码后须满足 `^[A-Za-z0-9_./-]{1,200}$`，且不能首尾是 `/`、不能有空段、`.`、`..`，否则 400 `INVALID_ARGUMENT`。
  路径里的斜杠必须编码成 `%2F`；未编码的 `documents/a/b` 不匹配任何路由（404）。
- **`data` 原样保存**：大整数、`1.0`、`1e2` 这类数值字面量不经过数值往返；输出是去掉空白的紧凑形式；`size_bytes` 按客户端发来的原文字节计。
- **列表**：按键（字节序）排序、不含 `data`；`limit` 缺省、非数字或 ≤ 0 时取 100（上限 500 按源码确认）；`next_cursor` 在没有下一页时为 `null`。
- **变更流**：`seq` 严格递增；`has_more` 表示本页之后还有；空页的 `next_cursor` 回显请求里的游标（从空游标开始且没有变更时为 `null`）；
  PUT 体里的 `device_id` 记入 `updated_by_device` 与变更的 `device_id`。
- **410 判定**：该应用还有变更、却没有任何一条 seq ≤ 游标 → 410 `CURSOR_EXPIRED`。保留规则同为「最近 10000 条或 30 天，永远保留最新一条」
  （10000 条已实测；30 天与「保留最新一条」按源码确认，atm-relay 另有按时间裁剪的用例）。
- **游标**：不透明字符串；读不懂 → 400 `INVALID_ARGUMENT`。
- **未知接口**：404 `NOT_FOUND` 的 JSON 错误体。`/health/live` 同为 `{"ok":true}`。
- **wait**：AyanamiCloud 忽略这个参数、立即返回（实测）；客户端据 `GET /v1/apps/{app}` 有没有 `relay.long_poll` 决定长轮询还是定时轮询。

**客户端只能把修订号当不透明的单调值**：条件写原样回传上次拿到的修订号，409 时取响应里的 `current.revision`（不存在则 0）重试；
不要假设新建一定是 1、重建一定是删除前 + 2。ATM 的客户端（`packages/sync-protocol`）就是这样用的，契约用例也只断言这些。

有意的差异（对 ATM 客户端都没有影响，已在两边实测确认）：

| 行为                      | AyanamiCloud                                | atm-relay                                    | 原因                                                                                                           |
| ------------------------- | ------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 长轮询 `wait`             | 忽略                                        | 支持，≤ 25 秒；非整数 400                    | 扩展                                                                                                           |
| 游标格式                  | base64url 的偏移 / seq                      | 列表是上一页最后一个键、变更是 base36 的 seq | 不透明；列表改用键集分页，边写边翻不跳不重。**两边的游标互不通用（对方会回 400），换中继时客户端必须清空游标** |
| 比全库最大 seq 还大的游标 | 200 空页                                    | 410 `CURSOR_EXPIRED`                         | 从旧备份恢复后不会让客户端永远停住                                                                             |
| `prefix` 匹配             | 不区分 ASCII 大小写（SQL `LIKE`）           | 按字节精确匹配                               | ATM 的键全是小写，无影响                                                                                       |
| 已知路径用错方法          | 404                                         | 405 `METHOD_NOT_ALLOWED` + `Allow`           | 便于排障                                                                                                       |
| `keep_candidate: true`    | 保存冲突候选，409 带 `conflict_id`          | 不保存，`conflict_id` 恒为 null              | 中继不做冲突 UI                                                                                                |
| `devices/<id>/…` 键       | 要求设备已登记，否则 404 `DEVICE_NOT_FOUND` | 普通键                                       | 中继没有设备登记；`device_count` 恒为 0、`devices` 恒为空                                                      |
| 请求体里的非法 UTF-8      | 替换成 U+FFFD 后照收                        | 400 `BAD_REQUEST`                            | 不静默改数据                                                                                                   |
| 请求体字段名大小写        | 不敏感（Go 的 JSON 解码）                   | 只认小写                                     | 客户端都用小写                                                                                                 |
| 字符串里的 `<`、`>`、`&`  | 输出转义成 `<` 等                           | 原样输出                                     | JSON 语义相同                                                                                                  |
| 新建的修订号              | 删掉再建恰好是删除前 + 2（实测）            | 删过文档后新建取「删除用过的最大修订号 + 1」 | 从未删过文档的应用里仍从 1 开始；重建可能大于 + 2。删掉的键不留墓碑，磁盘有界（见「限额」）；同样防 ABA        |
| 配额                      | 无                                          | 文档数 / 总字节到顶 507                      | 防一枚泄露的 token 撑爆磁盘                                                                                    |
| CORS                      | 应用数据接口不带 CORS 头                    | `*`（见上文）                                | 允许网页版客户端直连                                                                                           |
| `device_id` 取值          | 任意字符串                                  | 1–128 个可见 ASCII，否则 400                 | 防日志与界面注入                                                                                               |

对任意兼容服务复跑这套契约：

```bash
RELAY_CONTRACT_URL=http://127.0.0.1:8790 RELAY_CONTRACT_APP=atm RELAY_CONTRACT_TOKEN=atr_… \
  pnpm --filter @ayanami-task/relay contract
# 可选：RELAY_CONTRACT_RETENTION=<服务端变更保留条数> 额外跑 410 用例（会写入 retention+2 次）
```

用例只在 `contract/<本次运行 ID>/` 前缀下读写并在结束时删掉自己的文档（变更流里会留下记录），请只对自己的测试实例运行。

## 安全说明

- **中继只见密文。** ATM 用配对时生成的空间密钥做 AES-256-GCM 端到端加密，AAD 绑定文档键；项目码经 HMAC 后才进键名。
  中继运营者（或拿到中继 token 的人）能看到键名、大小、时间，能删改或重放密文、拒绝服务，但读不到内容，
  也伪造不了命令、不能把一份密文挪到别的键下。
- **token 只存 SHA-256**；明文只在签发时出现一次（`initial-token.txt` 或 `token create` 的 stdout）。
- **日志不含 token、token 哈希与文档内容**：访问日志一行记方法、路径（含键名）、状态码、耗时、token ID 与来源地址，不记查询串。`--quiet` 可关掉访问日志。
- 键名与应用 ID 严格按正则校验；请求体先完整校验 JSON 与 UTF-8 再落库；头部 20 秒、整个请求 60 秒超时，挡慢速连接。
- 一个数据目录只应由一个 `serve` 进程使用（长轮询的唤醒在进程内）；管理命令可以随时并发执行。

## 开发

```bash
pnpm --filter @ayanami-task/relay typecheck
npx vitest run apps/relay
npx eslint apps/relay && npx prettier --check apps/relay
pnpm --filter @ayanami-task/relay build && node apps/relay/dist/atm-relay.mjs --help
```

源码结构：`server.ts`（请求管线与优雅退出）、`handlers.ts`（六个接口）、`documents.ts`（文档、修订号、变更流）、
`tokens.ts`（应用与 token）、`request-body.ts`（PUT 体的原文切片）、`limits.ts`（全部限额）、`commands.ts`（命令行）。

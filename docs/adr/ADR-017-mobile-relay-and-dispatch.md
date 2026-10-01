# ADR-017：手机同步走可自建的加密中继，派单只做用户点名的 Claude 会话

状态：Accepted（2026-09-30）

## 背景

用户要在手机上看电脑里的任务并发任务上来，手机发来的任务要能让 Claude 自动领取、完善目标并开工。
ATM 至今是纯本地工具：daemon 只监听 loopback，安全模型把「把本机服务暴露到网络」列为非目标。

## 决策

1. **不开放监听端口，只做出站同步。** 电脑侧连接器在 daemon 进程内运行，主动连接一个用户自己配置的中继；
   手机也只连中继。两端之间没有直连，也不需要公网 IP。
2. **中继协议取 AyanamiCloud「应用数据」接口的一个子集**（文档 + 修订号 + 变更游标）。维护者可以直接用自己的
   AyanamiCloud；开源用户用仓库里的 `atm-relay`（零第三方依赖、单文件、可 Docker）。仓库和安装包里不写任何默认服务器，
   做法与 RustDesk 的「自建服务器 + 客户端里填地址和 key」相同。AyanamiCloud 是私有仓库、没有开源许可，
   `atm-relay` 按公开的接口契约独立实现，不复制其代码。
3. **中继不可信。** 载荷用配对时生成的空间密钥做 AES-256-GCM 端到端加密，AAD 绑定文档键；项目码经 HMAC 后才进键名。
   配对码（二维码）在电脑本地展示，同时携带中继 token 与空间密钥。
4. **手机只能发白名单命令**：建任务、对已有任务派单。不做通用 REST 转发。命令 ID 即幂等键。
5. **派单只处理用户点名的任务。** 默认关闭；开启后只有手机勾选「交给 Claude」或桌面点「交给 Claude」才会拉起
   `claude -p` 无头会话，ATM 不会自己挑任务派出去。并发默认 1，权限模式默认 `auto`，由用户在设置里改。

## 与既有 ADR 的关系

- **ADR-010（不复制 Hub 通信）**：这里传的不是 Agent 之间的消息，也不是给 Agent 的「可信用户指令」，
  而是用户本人对自己任务台账的写入（等价于在桌面端点「新建任务」），落账身份仍是 USER。
  派单拉起的会话照常经 MCP 接入 ATM，跨 Agent 通信和评审仍归 CrossAgent Hub。
- **ADR-013（稀疏控制面）**：ATM 内部读取仍然是事件驱动。轮询只发生在连接器与中继之间（出站、可退避），
  快照按项目摘要去重，不变不写。派单会话的日志只进 `dispatch/logs`，不进项目事实。

## 后果

- 新增 `packages/sync-protocol`、`packages/sync`、`packages/agent-dispatch`、`apps/relay`、`apps/mobile`。
- 中继 token 与空间密钥经宿主的 `SecretStore` 加密落盘（桌面端由原生宿主代调 Windows DPAPI，不可用时拒绝保存），
  不进 Registry settings 表；相关写接口全部 USER_ONLY。
- `security-model.md` 增加中继与派单两节；README 说明同步是可选功能、默认关闭。
- AyanamiCloud 的变更接口没有长轮询，接它时是 3～4 秒定时轮询；`atm-relay` 支持 25 秒长轮询。

## 依赖理由

- 手机 App：Capacitor 8（与本机其它 Android 项目一致，网页资源打包进 APK）、`jsqr`（纯 JS 解二维码，Apache-2.0）。
- 桌面端二维码：`qrcode-generator`（MIT，零依赖，约 20 KB）。
- 压缩沿用已有的 `fflate`；加密只用 WebCrypto，Node 与 WebView 同一份代码。

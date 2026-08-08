# CrossAgent Hub 复用审计

参考仓库：`R:\Project_All\ayanamiAgent Hub`，审计基线 `6a28ddd`，工作树干净。参考仓库许可证为 `AGPL-3.0-only`。

本项目不在运行时依赖 Hub，也不直接复制 Hub 源文件；采用兼容 AGPL 的仓库许可证，并重新实现下列已验证设计。若后续直接复制文件，必须在本表补充源路径、commit、修改和版权信息。

| Hub 模块                                                                        | 处理           | TaskManager 落地                                                           | 理由                                                                  |
| ------------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `packages/protocol/src/constants.ts`、`schemas.ts`                              | 改写设计       | 单一 Zod 协议源、英文枚举、中文标签映射                                    | 保留运行时校验；移除消息、可信指令、重型评审枚举                      |
| `apps/hub/src/db/database.ts`                                                   | 改写设计       | Registry/Project 两类工厂，WAL、FULL、外键、busy timeout、trigram 自检     | Hub 只有单库且默认 `synchronous=NORMAL`，不满足规格                   |
| `apps/hub/src/db/migration-runner.ts`                                           | 改写设计       | 连续版本、文件名与 SHA-256 校验、历史缺口拒绝、在线迁移前备份              | 115 个相关基线测试通过，模式成熟；两类数据库需独立计划                |
| `apps/hub/src/services/store/context.ts`                                        | 改写设计       | 状态、事件、幂等响应、outbox 同事务；提交后发布                            | 保留最重要的原子性与事件可见性边界                                    |
| `apps/hub/src/services/store/tasks.ts`                                          | 部分改写       | 乐观版本、领取、检查项门槛、进度计算                                       | 新增层级/依赖环、8 层上限、父级汇总、租约、通用验收；移除强制代码评审 |
| `apps/hub/src/services/store/projects.ts` 与 `packages/cli/src/project-init.ts` | 改写设计       | `.ayanami-task/project.json`、Git root/common-dir、路径别名、项目创建 saga | TaskManager 数据库必须在受管数据目录，不能沿用 Hub 单库注册方式       |
| `apps/hub/src/websocket/project-socket.ts`                                      | 改写设计       | `since_seq` gap replay、队列溢出后 `RESYNC_REQUIRED`、提交后推送           | 保留确定性恢复；认证模型按本机 token 简化                             |
| `packages/client/src/index.ts`                                                  | 改写设计       | UI、CLI、MCP stdio 共用 typed REST/WebSocket client                        | 避免第二套行为                                                        |
| `apps/dashboard`                                                                | 仅复用交互模式 | React Query 精准失效、详情抽屉焦点恢复、真实 E2E                           | 不复用英文状态直出、localStorage 事实、Hub 专属页面与视觉             |
| `scripts/build-release.mjs`、`package-release.mjs`、`install-smoke.ps1`         | 改写设计       | 构建身份、原生 ABI、安装/便携双产物、checksum、SBOM、产物烟测              | Electron Forge 产物布局不同，必须针对打包应用重写                     |

明确拒绝复用：Codex Bridge、Claude Channel、Hook 投递、消息收件箱、可信用户指令、写入意图、冲突检测、终端 PTY、review bundle、隔离 worktree、凭证轮换与项目级会话票据。这些继续属于 Hub。

审计验证：2026-08-07 运行协议、client、迁移完整性、项目 join、Hub integration 共 5 个测试文件/115 个用例，全部通过。本机参考依赖的 SQLite 为 3.53.2，FTS5 与 trigram 可用。

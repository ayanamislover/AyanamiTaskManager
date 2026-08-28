# 发布清单

本清单只保存稳定发布规则、证据入口和已知非阻塞项。测试数量、性能实测、提交、
候选 fingerprint、产物大小与哈希均由 `scripts/assemble-release.ts` 从本轮原始报告生成，
不得手填到这里，也不得沿用上一候选的结果。

## 证据层

发布证据只能按以下顺序单调推进：

1. `SOURCE_DONE`：源码与文档实现完成，完整源码 fingerprint 已冻结；
2. `CI_VERIFIED`：同一 fingerprint 的 CI 或明确标注的本地 CI 等价门禁通过；
3. `PACKAGED_VERIFIED`：同一候选 Setup 的 packaged 与 portable 验收通过；
4. `INSTALLED_VERIFIED`：同一候选 Setup 的安装、运行、重启、数据连续性和卸载验收通过。

不得跳级。任一层的 fingerprint、Git HEAD、source/lockfile hash、stage hash 或 Setup
字节身份不一致时，后续层必须拒绝推进。`SOURCE_DONE` 不能写成发布完成；本地 CI 等价证据
也不能冒充 GitHub Actions 运行记录。

## 稳定签发规则

- 输入必须是可由声明 HEAD 直接检出的干净工作树；发布校验后源码变化即作废。
- `--resume` 只允许完整 fingerprint 一致时复用，不能用局部 stage hash 绕过稳定签发门禁。
- CI 门禁覆盖格式、lint、类型、单元/集成、构建；Windows 发布验证覆盖 E2E、benchmark、
  Forge make、packaged、portable、distribution 与 installed smoke。
- packaged 与 installed 层必须读取逐项报告；顶层布尔值不能替代逐项检查。
- Setup 和 portable ZIP 都进入发布 manifest 与 checksum 文件；installed receipt 必须绑定
  实际安装的 Setup 身份和运行实例自报版本。
- 正式安装验收必须从真实 `%LOCALAPPDATA%` 运行；不得使用只对单个 Agent 可见的覆盖层。
- 发布前处理占用安装目录的桌面实例与 MCP stdio bridge；不得结束无关进程。
- 用户数据目录不属于卸载产物，安装、升级和卸载均不得误删。

## 执行入口

完整本地发布与安装验收：

```powershell
pnpm exec tsx scripts/release-and-install.ts --version <target-version>
```

只生成候选制品时使用 `--skip-install`。底层入口仍是 `pnpm release -- --full`；稳定签发不得
依靠局部复用。独立 Windows workflow 的原始报告与制品必须上传，供 GitHub 侧复核。

## 证据入口

- `release/test-report/summary.json`：候选身份、最高证据层、逐层来源与原始证据哈希；
- `release/test-report/summary.md`：从同一数据动态生成的人类可读报告；
- `release/test-report/release-verification.json` 与 `logs/`：源码/CI 等价门禁；
- `release/test-report/*-smoke-report.json`：packaged、portable、installed、distribution 逐项验收；
- `release/release.json`、`release/SHA256SUMS.txt`：候选与制品身份；
- `output/release-and-install.json`：最终当前安装实例回执；
- GitHub Actions 的 Windows release-validation run 与上传 artifact：远程 CI 证据。

## 非阻塞项

| 条目 | 说明 | 证据入口 |
| ---- | ---- | -------- |

空表表示当前没有已知非阻塞项；这不代表候选已经通过任何证据层。发现缺口时在表内登记，
并由生成报告原样带入。阻塞项不得降级写入本表。

## 历史说明

旧候选的手填验收数字和哈希仅保留在 Git 历史及其不可变发布制品中。它们不得出现在当前
动态清单，也不得被新候选的 assembler 读取为当前证据。

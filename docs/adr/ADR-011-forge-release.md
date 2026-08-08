# ADR-011：Electron Forge 与双 Windows 产物

状态：Accepted

使用 Electron Forge、Squirrel maker、ZIP maker 与 Auto Unpack Natives：Squirrel 提供 Win10/11 安装/升级，ZIP 提供便携包，插件确保 `better-sqlite3` 位于 ASAR 外并按 Electron ABI 重建。Forge 解决 Electron 打包、原生依赖修复和 maker 编排，现有 Vite/tsup 只负责编译，不能替代安装器。

Forge 7 的 `@electron/rebuild` 使用 Electron 维护的 Git node-gyp 子依赖；仓库 `pnpm-workspace.yaml` 仅对本项目设置 `blockExoticSubdeps: false`，实际 commit 与完整性由 `pnpm-lock.yaml` 固定。全局 pnpm 配置不修改。

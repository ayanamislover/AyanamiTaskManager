import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const MCP_SHIM_CRATE = "apps/desktop/native/mcp-shim";
/** forge 的 extraResource 按文件名拷进 resources\，也就是 mcpLaunch 找的 resources\atm-mcp.exe。 */
export const MCP_SHIM_RELEASE_EXE = `${MCP_SHIM_CRATE}/target/release/atm-mcp.exe`;

/**
 * 打包前从源码构建原生 MCP shim。
 *
 * 构建失败或没有 cargo 一律直接报错，不回落：回落的包里没有 shim，装上以后 Agent 配置
 * 照样能连（mcpLaunch 回落到 JS 桥），于是一路是绿的，而这一版要交付的东西恰恰没交付。
 *
 * ATM_REQUIRE_VERSION_RESOURCE=1 让 build.rs 在找不到 rc.exe 时失败：没有版本资源的未签名
 * exe 既不好在任务管理器里认，也更容易被杀毒软件启发式盯上。
 */
export function buildMcpShim(root: string): string {
  const crate = join(root, MCP_SHIM_CRATE);
  const result = spawnSync("cargo", ["build", "--release", "--locked", "--bin", "atm-mcp"], {
    cwd: crate,
    env: { ...process.env, ATM_REQUIRE_VERSION_RESOURCE: "1" },
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT")
    throw new Error(
      "MCP_SHIM_TOOLCHAIN_MISSING: 打包需要 Rust 工具链（rustup + MSVC）与 Windows SDK 的 rc.exe；" +
        `版本见 ${MCP_SHIM_CRATE}/rust-toolchain.toml`,
    );
  if (result.error || result.status !== 0)
    throw new Error(
      `MCP_SHIM_BUILD_FAILED: cargo build 退出 ${String(result.status)}` +
        (result.error ? `：${result.error.message}` : ""),
    );
  const exe = join(root, MCP_SHIM_RELEASE_EXE);
  if (!existsSync(exe)) throw new Error(`MCP_SHIM_ARTIFACT_MISSING: ${exe}`);
  return exe;
}

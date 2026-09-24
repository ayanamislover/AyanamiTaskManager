import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { SHIM_CRATE } from "./native-shim.js";

// 原生 shim 的格式、lint 与 Rust 单测挂在 pnpm test 上：CI、发布流水线和本地共用这一个入口，
// 不必再给发布报告加一个阶段。cargo 缺失一律是失败而不是跳过——跳过的门永远是绿的。
function cargo(args: string[]): { status: number | null; output: string } {
  const result = spawnSync("cargo", args, {
    cwd: SHIM_CRATE,
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    status: result.error ? null : result.status,
    output: `${result.error?.message ?? ""}${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

describe("native MCP shim quality gates", () => {
  it("cargo fmt --check", () => {
    const result = cargo(["fmt", "--check"]);
    expect(result.status, result.output).toBe(0);
  });

  it("cargo clippy 无警告", { timeout: 300_000 }, () => {
    const result = cargo(["clippy", "--locked", "--all-targets", "--", "-D", "warnings"]);
    expect(result.status, result.output).toBe(0);
  });

  it("cargo test", { timeout: 300_000 }, () => {
    const result = cargo(["test", "--locked"]);
    expect(result.status, result.output).toBe(0);
  });
});

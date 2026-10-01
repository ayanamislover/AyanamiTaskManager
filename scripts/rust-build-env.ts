import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * 发布用 cargo 构建的环境：把构建机的路径从二进制里抹掉。
 *
 * 依赖 crate 的 panic 位置等字符串会带上它的源码绝对路径，也就是
 * `C:\Users\<用户名>\.cargo\registry\src\…`——不处理的话，每个发出去的 exe 都写着打包人的
 * Windows 用户名。`--remap-path-prefix` 把 cargo 主目录和仓库根换成固定的占位前缀。
 *
 * 用 CARGO_ENCODED_RUSTFLAGS（0x1f 分隔）而不是 RUSTFLAGS：路径里有空格时 RUSTFLAGS 会被
 * 按空白拆开。测试里构建同一个 target 目录时也要用这一份，否则两边的 flag 不同，cargo 会
 * 来回整棵重编。
 *
 * 继承来的 CARGO_TARGET_DIR 不要：指到仓库外时，build script 生成的 OUT_DIR 路径不在
 * 重映射范围里，而且产物不在调用方去取的 `<crate>\target`，拿到的可能是旧的。
 * 要别的 target 目录的调用方（drill/smoke）自己在这之后设，都在 crate 目录下。
 */
export function releaseRustEnv(
  root: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const separator = String.fromCharCode(0x1f);
  const inherited =
    base.CARGO_ENCODED_RUSTFLAGS !== undefined
      ? base.CARGO_ENCODED_RUSTFLAGS.split(separator).filter(Boolean)
      : (base.RUSTFLAGS ?? "").split(/\s+/u).filter(Boolean);
  const flags = [
    ...inherited,
    `--remap-path-prefix=${cargoHome(base)}=/cargo`,
    `--remap-path-prefix=${resolve(root)}=/atm`,
  ];
  const env: NodeJS.ProcessEnv = { ...base, CARGO_ENCODED_RUSTFLAGS: flags.join(separator) };
  delete env.CARGO_TARGET_DIR;
  return env;
}

export function cargoHome(base: NodeJS.ProcessEnv = process.env): string {
  return resolve(base.CARGO_HOME ?? join(homedir(), ".cargo"));
}

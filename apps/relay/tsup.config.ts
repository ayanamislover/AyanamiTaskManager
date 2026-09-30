// 打成一个零依赖的单文件：dist/atm-relay.mjs。
// 只用类型导入：Docker 构建阶段是在隔离目录里装的 tsup，配置文件运行时不必能解析到 "tsup"。
import type { Options } from "tsup";

export default {
  entry: { "atm-relay": "src/cli.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: false,
  dts: false,
  outExtension: () => ({ js: ".mjs" }),
  banner: { js: "#!/usr/bin/env node" },
} satisfies Options;

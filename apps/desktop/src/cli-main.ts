import { createCliProgram } from "@ayanami-task/cli";

/**
 * CLI 入口（打包为 runtime\cli.mjs）。独立文件、只用 daemon.json 里的 Agent 凭证，
 * 打包产物里不含用户代理代码路径（de-electron §4）。只依赖 CLI 包，不引 daemon——
 * 否则 fastify 等服务端依赖会被一起打进来。
 *
 * 兼容旧的桌面参数：`--doctor`、`--cli <命令…>`；`atm.cmd` 直接透传参数。
 */
function cliArguments(argv: string[]): string[] {
  if (argv[0] === "--doctor") return ["doctor"];
  return argv[0] === "--cli" ? argv.slice(1) : argv;
}

createCliProgram()
  .parseAsync(["node", "atm", ...cliArguments(process.argv.slice(2))])
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });

// atm-relay 入口。构建产物 dist/atm-relay.mjs 由 tsup 从这里打成单文件（shebang 由 tsup banner 加）。
import { runCli } from "./commands.js";

const code = await runCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
});
process.exitCode = code;

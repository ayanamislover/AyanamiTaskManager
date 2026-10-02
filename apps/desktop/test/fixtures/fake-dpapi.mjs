// 假宿主的 `--dpapi protect|unprotect`（native/host/src/dpapi.rs 的协议）：stdin 一行 hex，stdout 一行 hex。
// 「加密」= 加上 "sealed:" 前缀并倒序，只为测协议与存储逻辑，不是真加密。
// FAKE_DPAPI_MODE 控制异常：fail（退出 1）、garbage（输出非 hex）、hang（不退出）、huge（输出超长）。
// FAKE_DPAPI_PID_DIR 设了就在里面留一个以自己 PID 命名的文件，测试据此核对 helper 有没有被结束。
import { writeFileSync } from "node:fs";
import { join } from "node:path";

if (process.env.FAKE_DPAPI_PID_DIR)
  writeFileSync(join(process.env.FAKE_DPAPI_PID_DIR, String(process.pid)), "");
const [flag, operation] = process.argv.slice(2);
const mode = process.env.FAKE_DPAPI_MODE ?? "ok";
const PREFIX = Buffer.from("sealed:");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  if (flag !== "--dpapi" || mode === "fail") process.exit(1);
  if (mode === "hang") {
    setInterval(() => undefined, 1000);
    return;
  }
  if (mode === "garbage") {
    process.stdout.write("not hex\n");
    return;
  }
  if (mode === "huge") {
    process.stdout.write("ab".repeat(200_000));
    return;
  }
  const data = Buffer.from(input.trim(), "hex");
  let output;
  if (operation === "protect") {
    output = Buffer.concat([PREFIX, Buffer.from(data).reverse()]);
  } else if (operation === "unprotect" && data.subarray(0, PREFIX.length).equals(PREFIX)) {
    output = Buffer.from(data.subarray(PREFIX.length)).reverse();
  } else {
    process.exit(1);
  }
  process.stdout.write(`${output.toString("hex")}\n`);
});

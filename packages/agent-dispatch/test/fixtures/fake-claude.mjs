// 假的 claude 命令行：经 process.execPath 运行，模拟 `claude -p --output-format stream-json`。
// 行为由工作目录里的 fake-claude.json 决定：{ "mode": "success" | "fail" | "error-result" | "slow", "delayMs": 数字 }。
// 每次运行都把收到的参数、stdin、工作目录与环境变量写进 fake-claude-dump-<ATM_DISPATCH_RUN>.json，供用例断言。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("9.9.9 (Fake Claude)\n");
  process.exit(0);
}

const behaviorPath = join(process.cwd(), "fake-claude.json");
const behavior = existsSync(behaviorPath) ? JSON.parse(readFileSync(behaviorPath, "utf8")) : {};
const mode = behavior.mode ?? "success";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const stdin = Buffer.concat(chunks).toString("utf8");
const run = process.env.ATM_DISPATCH_RUN ?? "unknown";
const sessionId = args[args.indexOf("--session-id") + 1] ?? null;

// 环境变量只记名字；值只记用例关心、且不含真实密钥的几个。
const shownValues = [
  "ATM_DISPATCH_RUN",
  "KEEP_DISPATCH_VALUE",
  "HTTPS_PROXY",
  "ANTHROPIC_BASE_URL",
];
writeFileSync(
  join(process.cwd(), `fake-claude-dump-${run}.json`),
  JSON.stringify({
    args,
    stdin,
    cwd: process.cwd(),
    envNames: Object.keys(process.env),
    env: Object.fromEntries(shownValues.map((name) => [name, process.env[name] ?? null])),
    pid: process.pid,
  }),
);

const line = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
line({ type: "system", subtype: "init", session_id: sessionId, cwd: process.cwd() });
line({ type: "assistant", message: { content: [{ type: "text", text: "开工" }] } });

async function finish() {
  if (mode === "fail") {
    process.stderr.write("fake-claude: boom\n");
    process.exit(2);
  }
  if (mode === "error-result") {
    line({
      type: "result",
      subtype: "success",
      is_error: true,
      num_turns: 1,
      duration_ms: 104,
      total_cost_usd: 0,
      result: "Failed to authenticate: OAuth session expired and could not be refreshed",
    });
    process.exit(1);
  }
  line({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 3,
    duration_ms: 1234,
    total_cost_usd: 0.0123,
    result: `完成 ${run}：${"很长的总结".repeat(200)}`,
  });
  process.exit(0);
}

if (mode === "slow") setTimeout(finish, behavior.delayMs ?? 60_000);
else await finish();

// 假的 claude 命令行：经 process.execPath 运行，模拟 `claude -p --output-format stream-json`。
// 行为由工作目录里的 fake-claude.json 决定：
//   { "mode": "success" | "fail" | "error-result" | "auth-stderr" | "api-error" | "slow", "delayMs": 数字 }。
// `auth status` 由环境变量 FAKE_CLAUDE_AUTH_FILE 指向的 JSON 决定：{ "mode": "in" | "out" | "hang" | "garbage" }，
// 没有这个变量时视为已登录；每探一次往 <文件>.count 追加一行，用例据此数探测次数。
// 每次运行都把收到的参数、stdin、工作目录与环境变量写进 fake-claude-dump-<ATM_DISPATCH_RUN>.json，供用例断言。
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("9.9.9 (Fake Claude)\n");
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "status") {
  const authFile = process.env.FAKE_CLAUDE_AUTH_FILE;
  let auth = { mode: "in" };
  if (authFile) {
    appendFileSync(`${authFile}.count`, "probe\n");
    if (existsSync(authFile)) auth = JSON.parse(readFileSync(authFile, "utf8"));
  }
  if (auth.mode === "hang") {
    setTimeout(() => process.exit(0), 60_000);
    await new Promise(() => {});
  }
  if (auth.mode === "garbage") {
    process.stdout.write("Usage: claude auth [command]\n");
    process.exit(0);
  }
  const loggedIn = auth.mode !== "out";
  // 与真 claude 一致：多行 JSON，未登录退出码 1。
  process.stdout.write(
    `${JSON.stringify(
      {
        loggedIn,
        authMethod: loggedIn ? "claude.ai" : "none",
        apiProvider: "firstParty",
      },
      null,
      2,
    )}\n`,
  );
  process.exit(loggedIn ? 0 : 1);
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
  if (mode === "auth-stderr") {
    process.stderr.write("Invalid API key · Please run /login\n");
    process.exit(1);
  }
  if (mode === "api-error") {
    // 与登录无关的失败；stderr 里夹一条 MCP 的 OAuth 提示，不能被当成「claude 没登录」。
    process.stderr.write('MCP server "figma" requires OAuth authorization\n');
    line({
      type: "result",
      subtype: "success",
      is_error: true,
      num_turns: 2,
      result: "API Error: 529 overloaded_error",
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

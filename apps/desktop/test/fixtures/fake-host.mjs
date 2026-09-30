// 假宿主：以改名成 AyanamiTaskManager.exe 的 node 运行，拉起打包 core，走一遍 host-control 协议。
// 结果以一行 JSON 写到 stdout，供 core-process.test.ts 断言。
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [coreExe, coreBundle, mode] = process.argv.slice(2);
const child = spawn(coreExe, [coreBundle], {
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
  windowsHide: true,
});
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => (stderr += chunk));
const frames = [];
const waiters = [];
let pending = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  pending += chunk;
  let index;
  while ((index = pending.indexOf("\n")) >= 0) {
    const frame = JSON.parse(pending.slice(0, index));
    pending = pending.slice(index + 1);
    frames.push(frame);
    for (const waiter of waiters.splice(0)) waiter();
  }
});
const send = (frame) => child.stdin.write(`${JSON.stringify(frame)}\n`);
const until = async (predicate, ms = 20_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = frames.find(predicate);
    if (found) return found;
    if (Date.now() > deadline || child.exitCode !== null) return null;
    await new Promise((resolve) => {
      waiters.push(resolve);
      setTimeout(resolve, 50);
    });
  }
};
const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));

const result = {};
send({
  t: "hello",
  v: 1,
  runId: "fake-host",
  version: "test",
  launch: { background: true, agentWake: false, randomStartupDelay: false },
});
result.ready = await until((frame) => frame.t === "ready");
if (result.ready && mode === "session-end") {
  // 注销：宿主转发 WM_ENDSESSION，等 core 回 marked，随后系统直接结束进程树。
  send({ t: "event", name: "session-end" });
  result.marked = await until((frame) => frame.t === "marked");
  child.kill();
} else if (result.ready) {
  send({ t: "req", id: 1, method: "runtimeRequest", args: [{ path: "/api/v1/overview" }] });
  send({
    t: "req",
    id: 2,
    method: "runtimeRequest",
    args: [
      {
        path: "/api/v1/settings/notification.mode",
        method: "PUT",
        headers: { "content-type": "application/json", authorization: "Bearer forged" },
        body: JSON.stringify({ value: "CRITICAL" }),
      },
    ],
  });
  send({
    t: "req",
    id: 3,
    method: "runtimeRequest",
    args: [{ path: "http://example.com/api/v1/overview" }],
  });
  send({ t: "req", id: 4, method: "getMemoryProfile", args: [] });
  for (const id of [1, 2, 3, 4])
    result[`res${id}`] = await until((frame) => frame.t === "res" && frame.id === id);
  result.tray = await until((frame) => frame.t === "tray");
  // 按指南直调 REST 的 Agent：只有 daemon.json 里的 Agent 凭证，写设置应当 403 且不改值。
  const descriptor = JSON.parse(
    readFileSync(join(process.env.ATM_DATA_DIR, "runtime", "daemon.json"), "utf8"),
  );
  result.agentTokenPinned = descriptor.token === process.env.AYANAMI_TASK_TOKEN;
  const agentWrite = await fetch(`${descriptor.endpoint}/api/v1/settings/notification.mode`, {
    method: "PUT",
    headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
    body: JSON.stringify({ value: "OFF" }),
  });
  result.agentWriteStatus = agentWrite.status;
  await agentWrite.text();
  send({ t: "req", id: 5, method: "runtimeRequest", args: [{ path: "/api/v1/settings" }] });
  result.res5 = await until((frame) => frame.t === "res" && frame.id === 5);
}
if (mode === "disconnect") child.stdin.end();
else if (mode !== "session-end") send({ t: "shutdown" });
result.exitCode = await exited;
result.stderr = stderr.slice(0, 2000);
process.stdout.write(`${JSON.stringify(result)}\n`);

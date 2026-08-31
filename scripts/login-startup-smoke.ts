import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = process.cwd();
const executable = resolve(
  process.env.ATM_PACKAGED_EXE ??
    join(root, "out", "AyanamiTaskManager-win32-x64", "AyanamiTaskManager.exe"),
);
const dataDir = resolve(join(root, "output", "login-startup-smoke-data"));
const userDataDir = resolve(join(root, "output", "login-startup-smoke-profile"));
const descriptorPath = join(dataDir, "runtime", "daemon.json");
const timeoutMs = 8_000;
type RuntimeDescriptor = { endpoint: string; token: string; version: string };

if (!existsSync(executable)) throw new Error(`找不到打包应用：${executable}`);
await rm(dataDir, { recursive: true, force: true });
await rm(userDataDir, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });

const inheritedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);
const environment = {
  ...inheritedEnvironment,
  ATM_DATA_DIR: dataDir,
  ATM_STARTUP_SMOKE: "1",
};
const startedAt = Date.now();
let stderr = "";
const application = spawn(
  executable,
  ["--background", "--random-startup-delay", `--user-data-dir=${userDataDir}`],
  {
    cwd: root,
    env: environment,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  },
);
application.stderr.on("data", (chunk: Buffer) => {
  stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_000);
});

const delay = (milliseconds: number) =>
  new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));

try {
  let descriptor: RuntimeDescriptor | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    if (application.exitCode !== null) {
      throw new Error(`登录启动进程提前退出：${application.exitCode}; ${stderr}`);
    }
    if (existsSync(descriptorPath)) {
      try {
        const candidate = JSON.parse(await readFile(descriptorPath, "utf8")) as RuntimeDescriptor;
        if (candidate.endpoint && candidate.token) {
          descriptor = candidate;
          break;
        }
      } catch {
        descriptor = null;
      }
    }
    await delay(50);
  }
  if (!descriptor) throw new Error(`登录启动在 ${timeoutMs}ms 内未发布 daemon 描述符；${stderr}`);
  const response = await fetch(`${descriptor.endpoint}/api/v1/system/status`, {
    headers: { authorization: `Bearer ${descriptor.token}` },
  });
  if (!response.ok) throw new Error(`登录启动后的服务不健康：${response.status}`);
  const elapsedMs = Date.now() - startedAt;
  process.stdout.write(
    `${JSON.stringify({ ok: true, elapsedMs, timeoutMs, version: descriptor.version, background: true, randomDelay: true })}\n`,
  );
} finally {
  await new Promise<void>((resolveQuit) => {
    execFile(
      executable,
      ["--smoke-quit", `--user-data-dir=${userDataDir}`],
      { cwd: root, env: environment, windowsHide: true, timeout: 5_000 },
      () => resolveQuit(),
    );
  });
  const exited =
    application.exitCode !== null
      ? true
      : await Promise.race([
          new Promise<boolean>((resolveExit) => application.once("exit", () => resolveExit(true))),
          delay(5_000).then(() => false),
        ]);
  if (!exited && application.exitCode === null) application.kill();
}

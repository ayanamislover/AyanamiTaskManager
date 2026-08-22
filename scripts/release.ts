import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertStageInputsResolve,
  computeReleaseFingerprint,
  decideReleaseResume,
  decideStageReuse,
  verifyReleaseSource,
  type ReleaseFingerprint,
  type ReleaseResumeDecision,
  type StageDecision,
} from "./release-fingerprint.js";

type CommandResult = {
  name: string;
  command: string;
  exitCode: number;
  durationMs: number;
  log: string;
};

const root = process.cwd();
const output = join(root, "output");
const logDir = join(output, "release-logs");
const reportPath = join(output, "release-verification.json");
const pnpm = "pnpm";
const commands: Array<{ name: string; args: string[] }> = [
  { name: "lint", args: ["lint"] },
  { name: "format", args: ["format:check"] },
  { name: "typecheck", args: ["typecheck"] },
  { name: "test", args: ["test"] },
  { name: "e2e", args: ["test:e2e"] },
  { name: "benchmark", args: ["benchmark"] },
  { name: "build", args: ["build"] },
  { name: "forge-make", args: ["exec", "tsx", "scripts/forge-make.ts"] },
  { name: "packaged-smoke", args: ["smoke:packaged"] },
  { name: "distribution-smoke", args: ["exec", "tsx", "scripts/distribution-smoke.ts"] },
];

await mkdir(logDir, { recursive: true });
// 声明烂掉会让阶段永远被复用且一路是绿的，所以在真实仓库上先验一次。
assertStageInputsResolve(
  execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean),
);
const resume = process.argv.includes("--resume");
const fingerprint = await computeReleaseFingerprint(root);
// 在十阶段开始前就拒绝脏工作树或「HEAD 还是旧版本」的升版输入，避免花完流水线
// 时间后才由 assembler 发现产物无法从声明 commit 重建。
await verifyReleaseSource(root, fingerprint);
// 按阶段复用不依赖 --resume：它就是「本地早就测过的东西不要再全量跑一遍」这句
// 话本身。--full 强制全部重跑。
const forceFull = process.argv.includes("--full");
const previous = existsSync(reportPath)
  ? (JSON.parse(await readFile(reportPath, "utf8")) as {
      fingerprint?: ReleaseFingerprint;
      commands?: CommandResult[];
    })
  : null;
const resumeDecision: ReleaseResumeDecision = decideReleaseResume(
  resume,
  previous?.fingerprint,
  fingerprint,
);
process.stdout.write(
  `[release] resume: ${resumeDecision.reuse ? "允许复用" : "重新执行"} (${resumeDecision.reason})\n`,
);
const reusable = new Map(
  (resumeDecision.reuse ? (previous?.commands ?? []) : [])
    .filter((result) => result.exitCode === 0)
    .map((result) => [result.name, result]),
);
const previousByName = new Map((previous?.commands ?? []).map((result) => [result.name, result]));
const stageDecisions: Record<string, StageDecision> = {};
const results: CommandResult[] = [];

async function run(name: string, args: string[]): Promise<CommandResult> {
  const started = performance.now();
  const chunks: string[] = [];
  process.stdout.write(`\n[release] ${name}: pnpm ${args.join(" ")}\n`);
  const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
    const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : pnpm;
    const commandArgs =
      process.platform === "win32" ? ["/d", "/s", "/c", [pnpm, ...args].join(" ")] : args;
    const child = spawn(command, commandArgs, {
      cwd: root,
      env: { ...process.env, CI: "1", NO_COLOR: "1" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const consume = (stream: NodeJS.ReadableStream, target: NodeJS.WriteStream) => {
      stream.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        chunks.push(text);
        target.write(text);
      });
    };
    if (child.stdout) consume(child.stdout, process.stdout);
    if (child.stderr) consume(child.stderr, process.stderr);
    child.once("error", rejectExit);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
  const log = join("release-logs", `${name}.log`);
  await writeFile(join(output, log), chunks.join(""), "utf8");
  return {
    name,
    command: `pnpm ${args.join(" ")}`,
    exitCode,
    durationMs: Math.round(performance.now() - started),
    log,
  };
}

for (const command of commands) {
  const stage = decideStageReuse(
    command.name,
    previous?.fingerprint,
    fingerprint,
    previousByName.get(command.name)?.exitCode,
  );
  stageDecisions[command.name] = stage;
  const globallyReusable = reusable.get(command.name);
  const stageReusable = !forceFull && stage.reuse ? previousByName.get(command.name) : undefined;
  const saved = globallyReusable ?? stageReusable;
  const result = saved ?? (await run(command.name, command.args));
  if (saved) {
    const why = globallyReusable ? resumeDecision.reason : stage.reason;
    process.stdout.write(`[release] ${command.name}: 复用已通过证据（${why}）\n`);
  }
  results.push(result);
  if (result.exitCode !== 0) break;
}

const passed =
  results.length === commands.length && results.every((result) => result.exitCode === 0);
await writeFile(
  reportPath,
  `${JSON.stringify(
    {
      passed,
      completedAt: new Date().toISOString(),
      fingerprint,
      resume: resumeDecision,
      stages: stageDecisions,
      commands: results,
    },
    null,
    2,
  )}\n`,
  "utf8",
);
if (!passed) {
  process.exitCode = results.at(-1)?.exitCode || 1;
} else {
  const assembled = await run("assemble-release", ["exec", "tsx", "scripts/assemble-release.ts"]);
  if (assembled.exitCode !== 0) process.exitCode = assembled.exitCode;
}

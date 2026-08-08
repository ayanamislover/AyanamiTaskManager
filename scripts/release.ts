import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  computeReleaseFingerprint,
  decideReleaseResume,
  type ReleaseFingerprint,
  type ReleaseResumeDecision,
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
const resume = process.argv.includes("--resume");
const fingerprint = await computeReleaseFingerprint(root);
const previous =
  resume && existsSync(reportPath)
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
  const saved = reusable.get(command.name);
  const result = saved ?? (await run(command.name, command.args));
  if (saved) process.stdout.write(`[release] ${command.name}: 复用已通过证据\n`);
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

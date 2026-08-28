import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertReleaseResumeEvidence,
  releaseResumeEvidencePaths,
  type ReleaseResumeEvidenceManifest,
} from "./release-artifact-evidence.js";
import {
  assertStageInputsResolve,
  computeReleaseFingerprint,
  decideReleaseResume,
  parseReleaseRunMode,
  selectReusableReleaseCommands,
  verifyReleaseSource,
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
const resumeEvidencePath = join(output, "release-resume-evidence.json");
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
const releaseMode = parseReleaseRunMode(process.argv.slice(2));
const fingerprint = await computeReleaseFingerprint(root);
// 在十阶段开始前就拒绝脏工作树或「HEAD 还是旧版本」的升版输入，避免花完流水线
// 时间后才由 assembler 发现产物无法从声明 commit 重建。
await verifyReleaseSource(root, fingerprint);
const previous = existsSync(reportPath)
  ? (JSON.parse(await readFile(reportPath, "utf8")) as {
      fingerprint?: ReleaseFingerprint;
      commands?: CommandResult[];
    })
  : null;
let resumeDecision: ReleaseResumeDecision =
  releaseMode === "full"
    ? { reuse: false, reason: "full-run-requested" }
    : decideReleaseResume(releaseMode === "resume", previous?.fingerprint, fingerprint);
if (resumeDecision.reuse) {
  try {
    if (!existsSync(resumeEvidencePath)) throw new Error("RELEASE_RESUME_EVIDENCE_MISSING");
    const evidenceManifest = JSON.parse(
      await readFile(resumeEvidencePath, "utf8"),
    ) as ReleaseResumeEvidenceManifest;
    await assertReleaseResumeEvidence(
      root,
      evidenceManifest,
      fingerprint,
      releaseResumeEvidencePaths(evidenceManifest.candidate, previous?.commands ?? []),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[release] resume 证据失效，转为全量执行：${message.slice(0, 300)}\n`);
    resumeDecision = { reuse: false, reason: "candidate-evidence-mismatch" };
  }
}
process.stdout.write(
  `[release] resume: ${resumeDecision.reuse ? "允许复用" : "重新执行"} (${resumeDecision.reason})\n`,
);
// 稳定签发只有这一条复用入口：完整 fingerprint 不匹配时 Map 必为空。局部
// stageHash 只用于 fingerprint 完整性与非签发诊断，不得在这里兜底。
const reusable = selectReusableReleaseCommands(resumeDecision, previous?.commands);
const stageDecisions: Record<string, { reuse: boolean; reason: string }> = {};
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
  stageDecisions[command.name] = {
    reuse: Boolean(saved),
    reason: saved ? resumeDecision.reason : "executed-current-run",
  };
  const result = saved ?? (await run(command.name, command.args));
  if (saved) {
    process.stdout.write(
      `[release] ${command.name}: 复用完整 fingerprint 已绑定的通过证据（${resumeDecision.reason}）\n`,
    );
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

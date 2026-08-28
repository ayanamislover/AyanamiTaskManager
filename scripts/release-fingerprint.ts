import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type ReleaseFingerprint = {
  version: 2;
  gitHead: string;
  dirty: boolean;
  dirtyStateHash: string;
  sourceHash: string;
  lockfileHash: string;
  stageHashes: Record<string, string>;
};

export type ReleaseSourceProvenance = {
  schemaVersion: 1;
  version: string;
  gitHead: string;
  dirty: false;
  dirtyStateHash: string;
  sourceHash: string;
  lockfileHash: string;
};

/**
 * 昂贵且作用域明确的阶段各自声明依赖：输入没变就复用上次的绿，而不是重证已证之事。
 *
 * 只收三个阶段。lint / format / typecheck / test 合计 26 秒就跑完 147 个用例，
 * 省它们既没收益又要担风险，一律照跑；build / forge-make / packaged-smoke 要产出
 * 并验证本版本的产物，也必须每次跑。
 *
 * 声明式而不是 --fast 开关：开关会用错（人判断"这次改动小"），声明不会——碰了
 * scripts/ 或 forge.config.ts，distribution-smoke 自动回来。
 */
export type StageInputs = {
  include: string[];
  /**
   * 只写「这个阶段确定不会读」的路径。方向严重不对称：漏排除不过是多跑一次，
   * 排错了却会让该跑的阶段被跳过，而且一路是绿的——所以这里只放能证明无关的目录。
   */
  exclude?: string[];
};

export const STAGE_INPUTS: Record<string, StageInputs> = {
  // 界面行为：渲染层、界面包，以及它调用的 daemon/协议/客户端。
  e2e: {
    include: [
      "apps/desktop/",
      "apps/daemon/",
      "packages/ui/",
      "packages/client/",
      "packages/protocol/",
      "playwright.config",
      // webServer 起的是它，改了它 e2e 跑的就是另一个东西。
      "scripts/start-e2e.ts",
    ],
    // playwright 的 testDir 是 apps/desktop/e2e，这些目录里是 vitest 单测，由 test
    // 阶段跑。不排掉的话，改一个单测文件就会作废 e2e——1.0.7 那次正是这样。
    exclude: [
      "apps/desktop/test/",
      "apps/daemon/test/",
      "packages/ui/test/",
      "packages/client/test/",
      "packages/protocol/test/",
    ],
  },
  // 性能阈值只跟存储与查询路径有关。
  benchmark: {
    include: [
      "packages/storage-sqlite/",
      "packages/application/",
      "packages/domain/",
      "migrations/",
      "scripts/benchmark.ts",
    ],
    exclude: [
      "packages/storage-sqlite/test/",
      "packages/application/test/",
      "packages/domain/test/",
    ],
  },
  // 它验的是安装器本身：打包配置、发布脚本、原生依赖和迁移。改一行 CSS 重跑
  // 一遍安装卸载，证明不了任何新东西。
  //
  // 这里不排任何东西。scripts/ 收得宽是有意的：安装链会外调其中一批脚本，
  // 而「装不上」的代价远大于多跑三十秒。
  "distribution-smoke": {
    include: [
      "forge.config.ts",
      "scripts/",
      "package.json",
      "pnpm-lock.yaml",
      "apps/desktop/src/",
      "migrations/",
    ],
  },
};

// 前缀匹配收敛到一处：包含命中、且没有被排除命中。
export function stageInputFiles(files: string[], inputs: StageInputs): string[] {
  return files.filter(
    (file) =>
      inputs.include.some((prefix) => file.startsWith(prefix)) &&
      !(inputs.exclude ?? []).some((prefix) => file.startsWith(prefix)),
  );
}

export type ReleaseResumeDecision = {
  reuse: boolean;
  reason:
    | "resume-not-requested"
    | "full-run-requested"
    | "previous-report-missing-fingerprint"
    | "fingerprint-match"
    | "fingerprint-mismatch"
    | "candidate-evidence-mismatch";
};

export type ReleaseRunMode = "standard" | "resume" | "full";

export function parseReleaseRunMode(args: readonly string[]): ReleaseRunMode {
  const unknown = args.filter((argument) => argument !== "--resume" && argument !== "--full");
  if (unknown.length > 0) throw new Error(`RELEASE_ARGUMENT_UNKNOWN: ${unknown.join(", ")}`);
  if (args.includes("--resume") && args.includes("--full")) {
    throw new Error("RELEASE_ARGUMENT_CONFLICT: --resume 与 --full 不能同时使用");
  }
  if (args.includes("--full")) return "full";
  if (args.includes("--resume")) return "resume";
  return "standard";
}

export type ReleaseCommandEvidence = {
  name: string;
  exitCode: number;
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex").toUpperCase();
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

export function commitReleasePreparation(
  root: string,
  targetVersion: string,
  files: readonly string[],
): string {
  if (files.length === 0) throw new Error("RELEASE_PREPARATION_EMPTY");
  execFileSync("git", ["add", "--", ...files], { cwd: root, stdio: "ignore" });

  const unstaged = execFileSync("git", ["diff", "--name-only"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (unstaged || untracked) {
    throw new Error(
      `RELEASE_PREPARATION_UNEXPECTED_DIRTY: ${[unstaged, untracked].filter(Boolean).join(", ")}`,
    );
  }

  try {
    execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: root, stdio: "ignore" });
    throw new Error("RELEASE_PREPARATION_EMPTY");
  } catch (error) {
    if ((error as { status?: number }).status !== 1) throw error;
  }

  execFileSync("git", ["commit", "--quiet", "-m", `chore: prepare release ${targetVersion}`], {
    cwd: root,
    stdio: "ignore",
  });
  const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]).trim();
  if (status) throw new Error(`RELEASE_PREPARATION_COMMIT_DIRTY: ${status}`);
  return git(root, ["rev-parse", "HEAD"]).trim();
}

const TEXT_FILE = /\.(?:ts|tsx|json|md|sql|css|html|ya?ml)$/u;

/**
 * 版本号散落在 package.json、apps/daemon/src/*、packages/storage-sqlite/src/manager.ts
 * 等七处站点里。按阶段判定复用时必须把它归一掉，否则每次升版都会让所有阶段的
 * 指纹一起变——依赖门永远不生效，整套设计变成空转。
 *
 * 版本号不是「会改变这个阶段该验什么」的输入：1.0.5 和 1.0.6 的安装器要验的
 * 东西完全一样。
 */
function normalizeVersion(content: Buffer, file: string, version: string | null): Buffer {
  if (!version || !TEXT_FILE.test(file)) return content;
  return Buffer.from(content.toString("utf8").split(version).join("<VERSION>"), "utf8");
}

async function sourceHash(
  root: string,
  files: string[],
  version: string | null = null,
): Promise<string> {
  const digest = createHash("sha256");
  for (const file of files.filter((path) => path !== "pnpm-lock.yaml").sort()) {
    digest.update(file);
    digest.update("\0");
    try {
      digest.update(normalizeVersion(await readFile(join(root, file)), file, version));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      digest.update("<missing>");
    }
    digest.update("\0");
  }
  return digest.digest("hex").toUpperCase();
}

export async function computeStageHashes(
  root: string,
  files: string[],
  version: string | null = null,
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const [stage, inputs] of Object.entries(STAGE_INPUTS)) {
    hashes[stage] = await sourceHash(root, stageInputFiles(files, inputs), version);
  }
  return hashes;
}

/**
 * 这套设计的致命失效是声明悄悄烂掉（目录改名、包被拆分）：匹配不到文件的前缀
 * 会让哈希不再随真实改动而变，该阶段从此永远被复用，而且一路是绿的。
 *
 * 校验是仓库健康断言，不是哈希的职责——所以它单独一个函数，由发布链在真实仓库
 * 上调用；computeStageHashes 保持纯粹，合成仓库（用例里的临时目录）照样能用。
 */
export function assertStageInputsResolve(
  files: string[],
  declaration: Record<string, StageInputs> = STAGE_INPUTS,
): void {
  for (const [stage, inputs] of Object.entries(declaration)) {
    for (const prefix of [...inputs.include, ...(inputs.exclude ?? [])]) {
      if (!files.some((file) => file.startsWith(prefix))) {
        throw new Error(`STAGE_INPUT_PREFIX_UNMATCHED: ${stage} 的 "${prefix}" 匹配不到任何文件`);
      }
    }
    // 排除项把包含项吃干净，等于这个阶段声明了「我没有输入」——哈希从此恒定，
    // 永远复用。空排除项只是多跑一次，这一条却是真会漏验的失效。
    if (stageInputFiles(files, inputs).length === 0) {
      throw new Error(`STAGE_INPUT_EXCLUDES_EVERYTHING: ${stage} 的排除项吃掉了全部输入`);
    }
  }
}

// 合成仓库（用例里的临时目录）可能没有 package.json。这时不归一，行为退回到
// 「版本号参与哈希」——对合成仓库无所谓，因为那里根本没有版本号站点。
async function readPackageVersion(root: string): Promise<string | null> {
  try {
    return (JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string })
      .version;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}

export async function computeReleaseFingerprint(root: string): Promise<ReleaseFingerprint> {
  const gitHead = git(root, ["rev-parse", "HEAD"]).trim();
  const dirtyState = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const files = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean);
  return {
    version: 2,
    gitHead,
    dirty: dirtyState.length > 0,
    dirtyStateHash: sha256(dirtyState),
    sourceHash: await sourceHash(root, files),
    lockfileHash: sha256(await readFile(join(root, "pnpm-lock.yaml"))),
    // 全局 sourceHash 保持含版本号（--resume 本来就该在升版后失效）；只有按阶段
    // 的指纹把版本号归一。
    stageHashes: await computeStageHashes(root, files, await readPackageVersion(root)),
  };
}

/**
 * 将发布报告中的输入指纹重新和当前 checkout 对齐，并证明 package 版本确实存在于
 * 声明的 HEAD。release.json 只引用 HEAD 不够：从脏工作树升版再构建时，那个提交
 * 检出的仍是旧版本。
 */
export async function verifyReleaseSource(
  root: string,
  verified: ReleaseFingerprint,
): Promise<ReleaseSourceProvenance> {
  const current = await computeReleaseFingerprint(root);
  if (!releaseFingerprintsMatch(verified, current)) {
    throw new Error("RELEASE_SOURCE_CHANGED_SINCE_VERIFICATION");
  }
  if (current.dirty) throw new Error("RELEASE_SOURCE_DIRTY");

  const workingVersion = await readPackageVersion(root);
  if (!workingVersion) throw new Error("RELEASE_PACKAGE_VERSION_MISSING");
  const committedPackage = JSON.parse(git(root, ["show", `${current.gitHead}:package.json`])) as {
    version?: string;
  };
  if (committedPackage.version !== workingVersion) {
    throw new Error(
      `RELEASE_HEAD_VERSION_MISMATCH: HEAD=${String(committedPackage.version)} working=${workingVersion}`,
    );
  }

  return {
    schemaVersion: 1,
    version: workingVersion,
    gitHead: current.gitHead,
    dirty: false,
    dirtyStateHash: current.dirtyStateHash,
    sourceHash: current.sourceHash,
    lockfileHash: current.lockfileHash,
  };
}

export type StageDecision = {
  reuse: boolean;
  reason:
    | "stage-has-no-declared-inputs"
    | "previous-stage-missing-or-failed"
    | "stage-inputs-unchanged"
    | "stage-inputs-changed";
};

/**
 * 非签发工作流中，单个昂贵阶段是否可以复用上次的绿。
 *
 * 这不是 release / release-and-install 的授权判定。稳定签发只能通过
 * decideReleaseResume 的完整 fingerprint 门；把本函数接进签发路径会让顶层
 * fingerprint mismatch 被局部 stageHash 绕过。
 */
export function decideNonReleaseStageReuse(
  stage: string,
  previousFingerprint: ReleaseFingerprint | null | undefined,
  current: ReleaseFingerprint,
  previousExitCode: number | null | undefined,
): StageDecision {
  if (!(stage in STAGE_INPUTS)) return { reuse: false, reason: "stage-has-no-declared-inputs" };
  if (previousExitCode !== 0) return { reuse: false, reason: "previous-stage-missing-or-failed" };
  const before = previousFingerprint?.stageHashes?.[stage];
  const now = current.stageHashes[stage];
  if (before && now && before === now) return { reuse: true, reason: "stage-inputs-unchanged" };
  return { reuse: false, reason: "stage-inputs-changed" };
}

export function releaseFingerprintsMatch(
  previous: ReleaseFingerprint | null | undefined,
  current: ReleaseFingerprint,
): boolean {
  if (!previous) return false;
  const expectedStageKeys = Object.keys(STAGE_INPUTS).sort();
  const previousStageHashes = previous.stageHashes;
  const currentStageHashes = current.stageHashes;
  if (
    !previousStageHashes ||
    typeof previousStageHashes !== "object" ||
    !currentStageHashes ||
    typeof currentStageHashes !== "object"
  ) {
    return false;
  }
  const previousStageKeys = Object.keys(previousStageHashes).sort();
  const currentStageKeys = Object.keys(currentStageHashes).sort();
  if (
    previousStageKeys.length !== expectedStageKeys.length ||
    currentStageKeys.length !== expectedStageKeys.length ||
    previousStageKeys.some((key, index) => key !== expectedStageKeys[index]) ||
    currentStageKeys.some((key, index) => key !== expectedStageKeys[index]) ||
    expectedStageKeys.some(
      (key) =>
        typeof previousStageHashes[key] !== "string" ||
        previousStageHashes[key].length === 0 ||
        previousStageHashes[key] !== currentStageHashes[key],
    )
  ) {
    return false;
  }
  return (
    previous.version === current.version &&
    previous.gitHead === current.gitHead &&
    previous.dirty === current.dirty &&
    previous.dirtyStateHash === current.dirtyStateHash &&
    previous.sourceHash === current.sourceHash &&
    previous.lockfileHash === current.lockfileHash
  );
}

export function decideReleaseResume(
  resumeRequested: boolean,
  previous: ReleaseFingerprint | null | undefined,
  current: ReleaseFingerprint,
): ReleaseResumeDecision {
  if (!resumeRequested) return { reuse: false, reason: "resume-not-requested" };
  if (!previous) return { reuse: false, reason: "previous-report-missing-fingerprint" };
  return releaseFingerprintsMatch(previous, current)
    ? { reuse: true, reason: "fingerprint-match" }
    : { reuse: false, reason: "fingerprint-mismatch" };
}

/**
 * 签发流水线唯一的旧结果复用入口。调用者不得再把本函数的空结果与阶段级缓存
 * 合并；完整 fingerprint 不匹配时必须得到零复用。
 */
export function selectReusableReleaseCommands<T extends ReleaseCommandEvidence>(
  resumeDecision: ReleaseResumeDecision,
  previousCommands: readonly T[] | null | undefined,
): Map<string, T> {
  if (!resumeDecision.reuse) return new Map();
  return new Map(
    (previousCommands ?? [])
      .filter((result) => result.exitCode === 0)
      .map((result) => [result.name, result]),
  );
}

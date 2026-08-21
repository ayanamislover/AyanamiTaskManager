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
export const STAGE_INPUTS: Record<string, string[]> = {
  // 界面行为：渲染层、界面包，以及它调用的 daemon/协议/客户端。
  e2e: [
    "apps/desktop/",
    "apps/daemon/",
    "packages/ui/",
    "packages/client/",
    "packages/protocol/",
    "playwright.config",
  ],
  // 性能阈值只跟存储与查询路径有关。
  benchmark: [
    "packages/storage-sqlite/",
    "packages/application/",
    "packages/domain/",
    "migrations/",
    "scripts/benchmark.ts",
  ],
  // 它验的是安装器本身：打包配置、发布脚本、原生依赖和迁移。改一行 CSS 重跑
  // 一遍安装卸载，证明不了任何新东西。
  "distribution-smoke": [
    "forge.config.ts",
    "scripts/",
    "package.json",
    "pnpm-lock.yaml",
    "apps/desktop/src/",
    "migrations/",
  ],
};

export type ReleaseResumeDecision = {
  reuse: boolean;
  reason:
    | "resume-not-requested"
    | "previous-report-missing-fingerprint"
    | "fingerprint-match"
    | "fingerprint-mismatch";
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex").toUpperCase();
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
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
  for (const [stage, prefixes] of Object.entries(STAGE_INPUTS)) {
    const matched = files.filter((file) => prefixes.some((prefix) => file.startsWith(prefix)));
    hashes[stage] = await sourceHash(root, matched, version);
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
export function assertStageInputsResolve(files: string[]): void {
  for (const [stage, prefixes] of Object.entries(STAGE_INPUTS)) {
    for (const prefix of prefixes) {
      if (!files.some((file) => file.startsWith(prefix))) {
        throw new Error(`STAGE_INPUT_PREFIX_UNMATCHED: ${stage} 的 "${prefix}" 匹配不到任何文件`);
      }
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

export type StageDecision = {
  reuse: boolean;
  reason:
    | "stage-has-no-declared-inputs"
    | "previous-stage-missing-or-failed"
    | "stage-inputs-unchanged"
    | "stage-inputs-changed";
};

/**
 * 单个阶段是否可以复用上次的绿。和全局 --resume 不同，这条是自动的：它正是
 * 「本地早就测过的东西不要再全量跑一遍」这句话的实现。
 */
export function decideStageReuse(
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

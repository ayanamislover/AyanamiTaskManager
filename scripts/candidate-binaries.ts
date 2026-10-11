/**
 * 发布候选绑定（09 §3，L6）：打包阶段一次构建出候选的五个 exe，记下哈希；之后每份验收报告写出
 * 自己实际运行的那份 exe 的哈希，assemble-release 逐份对上，有一处不同就拒绝组装——绿灯必须来自
 * 这次要发的那份二进制，而不是旁边某次旧构建或测试构建。
 *
 * 两套：release 是要发的候选；smoke 是同一次打包里带 smoke feature 的测试宿主（09 L5，packaged-smoke
 * 用它，CLI / shim / setup / 启动器与 release 是同一份文件）。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { unzipSync } from "fflate";
import { APP_LAYOUT } from "./app-layout.js";

export const CANDIDATE_BINARIES_FILE = "candidate-binaries.json";
export const BINARY_KEYS = ["host", "launcher", "setup", "cli", "mcpShim"] as const;
export type BinaryKey = (typeof BINARY_KEYS)[number];
export type BinarySet = Record<BinaryKey, string>;
export type CandidateBinaries = {
  schema: 1;
  version: string;
  release: BinarySet;
  smoke: BinarySet;
};

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** 一个版本目录（`app-<v>` 或解开的便携目录）里五个 exe 的哈希。 */
export function binariesOf(appDir: string): BinarySet {
  const set = {} as BinarySet;
  for (const key of BINARY_KEYS) {
    const path = join(appDir, APP_LAYOUT[key]);
    if (!existsSync(path)) throw new Error(`CANDIDATE_BINARY_MISSING: ${path}`);
    set[key] = sha256File(path);
  }
  return set;
}

export function candidateBinariesPath(root: string): string {
  return join(root, "output", "package", CANDIDATE_BINARIES_FILE);
}

/** 打包阶段的最后一步：两套哈希写在候选旁边。 */
export function writeCandidateBinaries(
  root: string,
  input: { version: string; releaseAppDir: string; smokeAppDir: string },
): CandidateBinaries {
  const candidate: CandidateBinaries = {
    schema: 1,
    version: input.version,
    release: binariesOf(input.releaseAppDir),
    smoke: binariesOf(input.smokeAppDir),
  };
  writeFileSync(candidateBinariesPath(root), `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
  return candidate;
}

export function readCandidateBinaries(root: string): CandidateBinaries {
  const path = candidateBinariesPath(root);
  if (!existsSync(path)) throw new Error(`CANDIDATE_BINARIES_MISSING: ${path}`);
  const value = JSON.parse(readFileSync(path, "utf8")) as CandidateBinaries;
  for (const set of [value.release, value.smoke])
    for (const key of BINARY_KEYS)
      if (!/^[0-9a-f]{64}$/u.test(set?.[key] ?? ""))
        throw new Error(`CANDIDATE_BINARIES_INVALID: ${key}`);
  return value;
}

/** 版本 zip（或便携 zip，`prefix` 是它的顶层目录）里五个 exe 的哈希：发出去的就是记下的那份。 */
export function zipBinaries(zip: Uint8Array, prefix = ""): BinarySet {
  const names = Object.fromEntries(
    BINARY_KEYS.map((key) => [key, `${prefix}${APP_LAYOUT[key].split(sep).join("/")}`]),
  ) as Record<BinaryKey, string>;
  const wanted = new Set(Object.values(names));
  const entries = unzipSync(zip, { filter: (file) => wanted.has(file.name) });
  const set = {} as BinarySet;
  for (const key of BINARY_KEYS) {
    const bytes = entries[names[key]];
    if (!bytes) throw new Error(`CANDIDATE_BINARY_MISSING: ${names[key]}`);
    set[key] = createHash("sha256").update(bytes).digest("hex");
  }
  return set;
}

/** 各份验收报告里记下的 `binaries`（字段缺失就是没绑）。 */
export type BoundReports = {
  packaged: { binaries?: Partial<BinarySet> };
  portable: { binaries?: Partial<BinarySet> };
  distribution: { binaries?: Partial<BinarySet> | null };
  installed: { binaries?: Partial<BinarySet> } | null;
  drill: { binaries?: Partial<BinarySet> };
  budget: { binaries?: { production?: Partial<BinarySet>; smoke?: Partial<BinarySet> } };
};

/** 演练包里的 setup 是 drill 构建（带沙箱与故障注入），只比其余四个。 */
export const DRILL_BOUND_KEYS = ["host", "launcher", "cli", "mcpShim"] as const;

/** 所有报告与候选对不上的地方；空数组才放行。 */
export function candidateBindingMismatches(
  candidate: CandidateBinaries,
  reports: BoundReports,
): string[] {
  const { release, smoke } = candidate;
  return [
    ...bindingMismatches("packaged-smoke", smoke, reports.packaged.binaries),
    ...bindingMismatches("portable-smoke", release, reports.portable.binaries),
    ...bindingMismatches("distribution-smoke", release, reports.distribution.binaries ?? undefined),
    ...(reports.installed
      ? bindingMismatches("installed-smoke", release, reports.installed.binaries)
      : []),
    ...bindingMismatches("install-drill", release, reports.drill.binaries, DRILL_BOUND_KEYS),
    ...bindingMismatches("budget.production", release, reports.budget.binaries?.production),
    ...bindingMismatches("budget.smoke", smoke, reports.budget.binaries?.smoke),
  ];
}

/**
 * 报告里记下的哈希与候选对不上的键（`label.key`）。`keys` 是这份报告该绑的那几个：演练用 drill
 * 构建的 setup，就不拿它比。报告没写哈希也算对不上。
 */
export function bindingMismatches(
  label: string,
  expected: BinarySet,
  actual: Partial<BinarySet> | undefined,
  keys: readonly BinaryKey[] = BINARY_KEYS,
): string[] {
  return keys
    .filter((key) => actual?.[key]?.toLowerCase() !== expected[key])
    .map((key) => `${label}.${key}`);
}

/**
 * 一个版本目录里的 exe 与期望的哪些对不上（`package.<key>`）；目录不完整就是 `package.missing`。
 * install-drill 用它判定上回留下的演练包还是不是当前构建打的。
 */
export function staleBinaryKeys(appDir: string, expected: BinarySet): string[] {
  try {
    return bindingMismatches("package", expected, binariesOf(appDir));
  } catch {
    return ["package.missing"];
  }
}

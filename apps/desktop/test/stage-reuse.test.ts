import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertStageInputsResolve,
  computeReleaseFingerprint,
  computeStageHashes,
  decideStageReuse,
  STAGE_INPUTS,
  type ReleaseFingerprint,
} from "../../../scripts/release-fingerprint.js";

const root = process.cwd();
const currentVersion = (
  JSON.parse(readFileSync(`${root}/package.json`, "utf8")) as {
    version: string;
  }
).version;

// 覆盖每个阶段声明的全部前缀。每个前缀留两个文件：下面用「拿掉一个」模拟改动，
// 不能把前缀清空——那会触发前缀未命中的严格校验，测的就不是复用判定了。
const FIXTURE_FILES = [
  "packages/ui/src/styles.css",
  "packages/ui/src/app.tsx",
  "apps/desktop/src/main.ts",
  "apps/desktop/src/preload.ts",
  "apps/daemon/src/index.ts",
  "packages/client/src/index.ts",
  "packages/protocol/src/index.ts",
  "playwright.config.ts",
  "packages/storage-sqlite/src/manager.ts",
  "packages/application/src/index.ts",
  "packages/domain/src/index.ts",
  "migrations/project/0001_initial.sql",
  "scripts/benchmark.ts",
  "scripts/release.ts",
  "scripts/version-sites.ts",
  "forge.config.ts",
  "package.json",
  "pnpm-lock.yaml",
];

function fingerprintWith(stageHashes: Record<string, string>): ReleaseFingerprint {
  return {
    version: 2,
    gitHead: "HEAD",
    dirty: false,
    dirtyStateHash: "D",
    sourceHash: "S",
    lockfileHash: "L",
    stageHashes,
  };
}

describe("按阶段依赖复用", () => {
  // 便宜的阶段一律照跑：lint/format/typecheck/test 合计 26 秒就跑完全部用例，
  // 省它们没收益还要担风险。build/forge-make/packaged-smoke 要产出并验证本
  // 版本的产物，也不能跳。
  it("只有三个昂贵且作用域明确的阶段声明了依赖", () => {
    expect(Object.keys(STAGE_INPUTS).sort()).toEqual(["benchmark", "distribution-smoke", "e2e"]);
    for (const cheap of ["lint", "format", "typecheck", "test", "build", "forge-make"]) {
      expect(decideStageReuse(cheap, fingerprintWith({}), fingerprintWith({}), 0).reuse).toBe(
        false,
      );
    }
  });

  it("输入没变才复用，变了就重跑，上次没绿也重跑", () => {
    const before = fingerprintWith({ e2e: "AAA", benchmark: "BBB", "distribution-smoke": "CCC" });
    const same = fingerprintWith({ e2e: "AAA", benchmark: "BBB", "distribution-smoke": "CCC" });
    const changed = fingerprintWith({ e2e: "ZZZ", benchmark: "BBB", "distribution-smoke": "CCC" });

    expect(decideStageReuse("e2e", before, same, 0)).toEqual({
      reuse: true,
      reason: "stage-inputs-unchanged",
    });
    expect(decideStageReuse("e2e", before, changed, 0)).toEqual({
      reuse: false,
      reason: "stage-inputs-changed",
    });
    // 上次是红的就不能复用——否则一次失败会被永久继承。
    expect(decideStageReuse("e2e", before, same, 1)).toEqual({
      reuse: false,
      reason: "previous-stage-missing-or-failed",
    });
    expect(decideStageReuse("e2e", before, same, undefined)).toEqual({
      reuse: false,
      reason: "previous-stage-missing-or-failed",
    });
    // 没有上一轮指纹（比如报告是旧版本格式）也不能复用。
    expect(decideStageReuse("e2e", null, same, 0).reuse).toBe(false);
  });

  it("改界面时 benchmark 与 distribution-smoke 复用，改 scripts 时后者必定重跑", async () => {
    const base = await computeStageHashes(root, FIXTURE_FILES, currentVersion);

    // 拿掉 scripts/release.ts：distribution-smoke 的哈希必须跟着变，benchmark 不受影响。
    const withoutReleaseScript = await computeStageHashes(
      root,
      FIXTURE_FILES.filter((file) => file !== "scripts/release.ts"),
      currentVersion,
    );
    expect(withoutReleaseScript["distribution-smoke"]).not.toBe(base["distribution-smoke"]);
    expect(withoutReleaseScript["benchmark"]).toBe(base["benchmark"]);
    expect(withoutReleaseScript["e2e"]).toBe(base["e2e"]);

    // 拿掉一个只属于 e2e 的界面文件：只有 e2e 变。
    const withoutUi = await computeStageHashes(
      root,
      FIXTURE_FILES.filter((file) => file !== "packages/ui/src/styles.css"),
      currentVersion,
    );
    expect(withoutUi["e2e"]).not.toBe(base["e2e"]);
    expect(withoutUi["benchmark"]).toBe(base["benchmark"]);
    expect(withoutUi["distribution-smoke"]).toBe(base["distribution-smoke"]);
  });

  // 版本号散落在 package.json 和多个 src 文件里，而这些正好落在三个阶段的
  // 依赖集内。不把它归一，每次升版都会让所有阶段指纹一起变，依赖门永远不生效——
  // 整套设计空转，而且看起来一切正常。
  it("升版本号不改变任何阶段的指纹", async () => {
    const normalized = await computeStageHashes(root, FIXTURE_FILES, currentVersion);
    // 用一个文件里根本不存在的版本串去归一，等于没归一。
    const absent = await computeStageHashes(root, FIXTURE_FILES, "9.9.9");
    const notNormalized = await computeStageHashes(root, FIXTURE_FILES, null);
    expect(absent).toEqual(notNormalized);
    // 归一确实改变了哈希，说明当前版本号真的被从内容里摘掉了——摘掉之后，
    // 换成任何新版本号都不会再影响这些哈希。
    for (const stage of ["distribution-smoke", "benchmark", "e2e"]) {
      expect(normalized[stage]).not.toBe(notNormalized[stage]);
    }
  });

  // 这套设计另一个致命失效：声明悄悄烂掉（目录改名、包被拆分）。那样哈希不再
  // 随真实改动而变，阶段从此永远被复用，而且一路是绿的。
  it("声明的前缀匹配不到文件时必须大声报错，不能兜底", () => {
    expect(() => assertStageInputsResolve(["packages/ui/src/styles.css"])).toThrow(
      /STAGE_INPUT_PREFIX_UNMATCHED/u,
    );
  });

  // 阳性对照：真实仓库里每一条声明都必须匹配得到文件。声明烂掉时这条先红。
  it("真实仓库里所有声明前缀都命中", async () => {
    const files = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: root, encoding: "utf8" },
    )
      .split("\0")
      .filter(Boolean);
    expect(files.length).toBeGreaterThan(50);
    expect(() => assertStageInputsResolve(files)).not.toThrow();
  });

  // 归一逻辑正确、但 computeReleaseFingerprint 忘了把版本号传进去，一样是空转。
  // package.json 读不到时会静默退回「不归一」，所以这条必须钉住真实接线。
  it("computeReleaseFingerprint 确实把当前版本号传给了阶段指纹", async () => {
    const files = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: root, encoding: "utf8" },
    )
      .split("\0")
      .filter(Boolean);
    const wired = await computeReleaseFingerprint(root);
    expect(wired.stageHashes).toEqual(await computeStageHashes(root, files, currentVersion));
    // 阳性对照：不传版本号会得到不同的结果，所以上一条不是恒等式。
    expect(wired.stageHashes).not.toEqual(await computeStageHashes(root, files, null));
  });
});

import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertReleaseChecklistIsDynamic as assertDynamicChecklistContent,
  releaseChecklistViolations,
} from "../../../scripts/release-checklist-contract.js";
import {
  assertReleaseChecklistIsDynamic,
  findVersionLeftovers,
  isVersionSiteLine,
  VERSIONED_FILES,
} from "../../../scripts/version-sites.js";

const root = process.cwd();
const currentVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  .version as string;

describe("版本号站点清单", () => {
  // 漏改一处版本号，Squirrel 会拿同名不同哈希的包当升级处理，装出来的还是旧版。
  it("清单里每个文件都确实含有当前版本号", () => {
    // Six current sites remain after daemon entrypoints switched to the
    // single runtime-discovery version source.
    expect(VERSIONED_FILES.length).toBeGreaterThanOrEqual(6);
    expect(currentVersion).toMatch(/^\d+\.\d+\.\d+$/u);
    const missing = VERSIONED_FILES.filter(
      (file) => !readFileSync(join(root, file), "utf8").includes(currentVersion),
    );
    expect(missing).toEqual([]);
  });

  it("源码里凡是硬编码了版本号的文件，都必须在清单里", () => {
    const roots = ["apps/daemon/src", "apps/desktop/src", "packages"];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const next = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "test")
            continue;
          walk(next);
        } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) files.push(next);
      }
    };
    for (const dir of roots) walk(dir);
    // 扫不到文件同样会让断言空转成绿，先把扫描面本身钉住。
    expect(files.length).toBeGreaterThan(20);
    const hardcoded = files.filter((file) =>
      readFileSync(join(root, file), "utf8").includes(`"${currentVersion}"`),
    );
    const outside = hardcoded.filter((file) => !VERSIONED_FILES.includes(file as never));
    expect(outside).toEqual([]);
    // 阳性对照：扫描确实找得到当前三个源码版本站点（daemon runtime discovery、
    // MCP server、SQLite manager），否则上面的断言只是在对空集成立。
    expect(hardcoded.length).toBeGreaterThanOrEqual(3);
  });
});

describe("升版后的残留检查", () => {
  // git grep 拿退出码当结果：0 有匹配，1 没有匹配。把非零一律当失败，这条检查
  // 就会在旧版本号被清得最干净时恰好挂掉——发布链因此在升版第一步就中止。
  it("没有匹配是通过，不是失败", () => {
    expect(findVersionLeftovers("9.9.9", () => ({ status: 1, stdout: "" }))).toEqual([]);
  });

  it("有残留时如实报出，真出错时不吞", () => {
    const stdout = ['package.json:3:  "version": "9.9.9",', "a.ts:9:  version: '9.9.9',", ""].join(
      "\n",
    );
    expect(findVersionLeftovers("9.9.9", () => ({ status: 0, stdout }))).toEqual([
      'package.json:3:  "version": "9.9.9",',
      "a.ts:9:  version: '9.9.9',",
    ]);
    expect(() => findVersionLeftovers("9.9.9", () => ({ status: 128, stdout: "" }))).toThrow(
      /GIT_GREP_FAILED/u,
    );
  });

  // 解释性注释里提到旧版本（「9.9.9 那次就是」）不是版本站点，但同样含有那串
  // 数字。纯子串匹配会把它们全报成漏改，历史注释越写越多误报越多，最后逼人去
  // 删注释讨好检查。真正的站点在 .ts/.json 里一律是带引号的字符串字面量。
  it("注释里的历史叙述不算版本站点", () => {
    const stdout = [
      "scripts/x.ts:7:// 9.9.9 那次 Squirrel 静默卸载留下开始菜单快捷方式",
      "apps/y.ts:13: * 两边就都不做——9.9.9 装完开始菜单里什么都没有",
      "docs/z.ts:2:// 见 9.9.9 的发布清单",
      "",
    ].join("\n");
    expect(findVersionLeftovers("9.9.9", () => ({ status: 0, stdout }))).toEqual([]);
    // 阳性对照：同一批行里只要有一行是真站点，就必须被报出来。
    const mixed = [
      "scripts/x.ts:7:// 9.9.9 那次就是",
      'apps/daemon/src/index.ts:112:      version: "9.9.9",',
      "",
    ].join("\n");
    expect(findVersionLeftovers("9.9.9", () => ({ status: 0, stdout: mixed }))).toEqual([
      'apps/daemon/src/index.ts:112:      version: "9.9.9",',
    ]);
  });

  it("版本号里的点不能当正则通配", () => {
    expect(isVersionSiteLine('x.ts:1: version: "9X9X9",', "9.9.9")).toBe(false);
    expect(isVersionSiteLine('x.ts:1: version: "9.9.9",', "9.9.9")).toBe(true);
  });
});

describe("动态发布清单", () => {
  it("升版只验证动态清单，不写回版本化待填结果", () => {
    const fixture = mkdtempSync(join(tmpdir(), "atm-release-checklist-"));
    try {
      mkdirSync(join(fixture, "docs"));
      const checklist = [
        "# 发布清单",
        "",
        "候选状态与数字由 assembler 动态生成。",
        "",
        "## 证据入口",
        "",
        "- `release/test-report/summary.json`",
        "",
      ].join("\n");
      const path = join(fixture, "docs", "release-checklist.md");
      writeFileSync(path, checklist, "utf8");

      assertReleaseChecklistIsDynamic(fixture);
      expect(readFileSync(path, "utf8")).toBe(checklist);

      for (const legacy of ["- [x] pnpm test", "## 1.2.3 验收结果", "本轮尚未完成，结果待填。"]) {
        writeFileSync(path, `${checklist}${legacy}\n`, "utf8");
        expect(() => assertReleaseChecklistIsDynamic(fixture)).toThrow(
          "RELEASE_CHECKLIST_STATIC_EVIDENCE_NOT_ALLOWED",
        );
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("逐条拒绝历史静态验收句式", () => {
    const cases = [
      ["- [x] pnpm test", "MANUAL_CHECKMARK"],
      ["单元/集成：999 项通过", "MANUAL_TEST_COUNT"],
      ["smoke：33 项通过", "MANUAL_TEST_COUNT"],
      ["E2E：33 项通过", "MANUAL_TEST_COUNT"],
      ["packaged smoke：33 项通过", "MANUAL_TEST_COUNT"],
      ["portable smoke：33 项通过", "MANUAL_TEST_COUNT"],
      ["installed smoke：33 项通过", "MANUAL_TEST_COUNT"],
      ["服务 RSS <= 150 MB", "MANUAL_PERFORMANCE_NUMBER"],
      [`Git HEAD: ${"A".repeat(40)}`, "MANUAL_CANDIDATE_HASH"],
      ["## 1.2.3 验收结果", "VERSIONED_ACCEPTANCE_HEADING"],
      ["本轮尚未完成，结果待填。", "PENDING_ACCEPTANCE_RESULT"],
    ] as const;

    for (const [text, code] of cases) {
      expect(releaseChecklistViolations(text), text).toEqual([code]);
      expect(() => assertDynamicChecklistContent(text), text).toThrow(
        new RegExp(`RELEASE_CHECKLIST_STATIC_EVIDENCE_NOT_ALLOWED: ${code}`, "u"),
      );
    }
  });

  it("动态规则与证据入口不被误报", () => {
    const legal = [
      "# 发布清单",
      "",
      "候选 fingerprint、测试数量、性能实测与 SHA-256 均由 release assembler 动态生成。",
      "不得手填到这里，也不得沿用上一候选结果。",
      "",
      "## 证据层",
      "",
      "SOURCE_DONE → CI_VERIFIED → PACKAGED_VERIFIED → INSTALLED_VERIFIED。",
      "",
      "## 证据入口",
      "",
      "- `release/test-report/summary.json`",
      "- `release/SHA256SUMS.txt`",
    ].join("\n");
    expect(releaseChecklistViolations(legal)).toEqual([]);
    expect(() => assertDynamicChecklistContent(legal)).not.toThrow();
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findVersionLeftovers, VERSIONED_FILES } from "../../../scripts/version-sites.js";

const root = process.cwd();
const currentVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  .version as string;

describe("版本号站点清单", () => {
  // 漏改一处版本号，Squirrel 会拿同名不同哈希的包当升级处理，装出来的还是旧版。
  it("清单里每个文件都确实含有当前版本号", () => {
    expect(VERSIONED_FILES.length).toBeGreaterThanOrEqual(7);
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
    // 阳性对照：扫描确实找得到已知的那几处，否则上面的断言只是在对空集成立。
    expect(hardcoded.length).toBeGreaterThanOrEqual(4);
  });
});

describe("升版后的残留检查", () => {
  // git grep 拿退出码当结果：0 有匹配，1 没有匹配。把非零一律当失败，这条检查
  // 就会在旧版本号被清得最干净时恰好挂掉——发布链因此在升版第一步就中止。
  it("没有匹配是通过，不是失败", () => {
    expect(findVersionLeftovers("1.0.4", () => ({ status: 1, stdout: "" }))).toEqual([]);
  });

  it("有残留时如实报出，真出错时不吞", () => {
    expect(
      findVersionLeftovers("1.0.4", () => ({
        status: 0,
        stdout: "docs/user-guide.md:12:1.0.4\npackage.json:3:1.0.4\n",
      })),
    ).toEqual(["docs/user-guide.md:12:1.0.4", "package.json:3:1.0.4"]);
    expect(() => findVersionLeftovers("1.0.4", () => ({ status: 128, stdout: "" }))).toThrow(
      /GIT_GREP_FAILED/u,
    );
  });
});

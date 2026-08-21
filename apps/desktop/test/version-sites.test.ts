import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VERSIONED_FILES } from "../../../scripts/version-sites.js";

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

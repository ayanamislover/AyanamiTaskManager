import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repo = resolve(import.meta.dirname, "../../..");
const native = join(repo, "apps/desktop/native");

function rustFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory())
      return entry.name === "target" || entry.name.startsWith(".")
        ? []
        : rustFiles(join(dir, entry.name));
    return entry.name.endsWith(".rs") ? [join(dir, entry.name)] : [];
  });
}

/** 代码（不算注释）里用到 `DETACHED_PROCESS` 的行。 */
export function detachedUses(source: string): number[] {
  return source
    .split(/\r?\n/u)
    .flatMap((line, index) =>
      /\bDETACHED_PROCESS\b/u.test(line.replace(/\/\/.*$/u, "")) ? [index + 1] : [],
    );
}

/** 给宿主设数据根、却没有先导入 test-windows 的脚本。 */
export function startsHostsInTheForeground(source: string): boolean {
  return /\bATM3_DATA_DIR\b/u.test(source) && !source.includes('import "./test-windows.js";');
}

describe("测试与产品不弹窗（W8k）", () => {
  it("原生代码不用 DETACHED_PROCESS：分离的控制台程序再起控制台子进程，每个都会新开一个可见窗口", () => {
    const offenders = rustFiles(native).flatMap((file) =>
      detachedUses(readFileSync(file, "utf8")).map(
        (line) => `${relative(repo, file).replaceAll("\\", "/")}:${line}`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("拉起宿主的测试脚本都先导入 test-windows：宿主窗口不抢焦点、压在最底层", () => {
    const scripts = join(repo, "scripts");
    const offenders = readdirSync(scripts)
      .filter((name) => name.endsWith(".ts"))
      .filter((name) => startsHostsInTheForeground(readFileSync(join(scripts, name), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("导入 test-windows 之后，本进程拉起的宿主都带着后台窗口开关", async () => {
    const { BACKGROUND_WINDOW } = await import("../../../scripts/test-windows.js");
    expect(BACKGROUND_WINDOW).toBe("ATM_BACKGROUND_WINDOW");
    expect(process.env.ATM_BACKGROUND_WINDOW).toBe("1");
  });

  it("阳性对照：两条规则都认得出违例，也不把注释当成违例", () => {
    expect(detachedUses("let f = DETACHED_PROCESS | X;")).toEqual([1]);
    expect(detachedUses("// 不用 DETACHED_PROCESS\nconst A: u32 = 0x8;")).toEqual([]);
    expect(detachedUses("ok();\n    .creation_flags(DETACHED_PROCESS) // why")).toEqual([2]);
    expect(startsHostsInTheForeground("const env = { ATM3_DATA_DIR: n };")).toBe(true);
    expect(
      startsHostsInTheForeground('import "./test-windows.js";\nconst env = { ATM3_DATA_DIR: n };'),
    ).toBe(false);
    expect(startsHostsInTheForeground("const x = 1;")).toBe(false);
  });
});

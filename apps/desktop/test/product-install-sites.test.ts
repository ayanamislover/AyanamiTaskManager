import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSafeInstallRoot,
  clearStaleDeadMarker,
  findProductShortcuts,
  productShortcutRoots,
  removeProductShortcuts,
  walkProductFiles,
} from "../../../scripts/product-install-sites.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function shortcutFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "atm-shortcuts-"));
  temporary.push(root);
  mkdirSync(join(root, "Ayanami"), { recursive: true });
  writeFileSync(join(root, "AyanamiTaskManager.lnk"), "lnk", "utf8");
  writeFileSync(join(root, "Ayanami", "AyanamiTaskManager Desktop.lnk"), "lnk", "utf8");
  writeFileSync(join(root, "SomethingElse.lnk"), "lnk", "utf8");
  writeFileSync(join(root, "AyanamiTaskManager.txt"), "not a shortcut", "utf8");
  return root;
}

describe("产品安装位置", () => {
  it("按名字和扩展名找出产品快捷方式，递归子目录，不误伤别人", async () => {
    const root = shortcutFixture();
    const found = await findProductShortcuts([root]);
    expect(found.map((path) => path.slice(root.length + 1)).sort()).toEqual([
      "AyanamiTaskManager.lnk",
      "Ayanami\\AyanamiTaskManager Desktop.lnk",
    ]);
  });

  it("清理只删产品快捷方式", async () => {
    const root = shortcutFixture();
    const removed = await removeProductShortcuts([root]);
    expect(removed).toHaveLength(2);
    expect(await findProductShortcuts([root])).toEqual([]);
    expect(readdirSync(root).sort()).toEqual([
      "Ayanami",
      "AyanamiTaskManager.txt",
      "SomethingElse.lnk",
    ]);
  });

  it("不跟随开始菜单中的目录链接或循环 junction", async () => {
    const root = shortcutFixture();
    const outside = mkdtempSync(join(tmpdir(), "atm-shortcuts-outside-"));
    temporary.push(outside);
    writeFileSync(join(outside, "AyanamiTaskManager Outside.lnk"), "lnk", "utf8");
    symlinkSync(outside, join(root, "outside-junction"), "junction");
    symlinkSync(root, join(root, "loop-junction"), "junction");

    const found = await findProductShortcuts([root]);

    expect(found.map((path) => path.slice(root.length + 1)).sort()).toEqual([
      "AyanamiTaskManager.lnk",
      "Ayanami\\AyanamiTaskManager Desktop.lnk",
    ]);
  });

  it("超宽目录逐项汇总，不用 spread 把文件数变成调用栈参数", async () => {
    const root = "C:\\synthetic-root";
    const wide = join(root, "wide");
    const files = Array.from({ length: 70_000 }, (_, index) => ({
      name: `${index}.lnk`,
      isDirectory: () => false,
      isSymbolicLink: () => false,
    }));
    const found = await walkProductFiles(root, async (directory) =>
      directory === root
        ? [
            {
              name: "wide",
              isDirectory: () => true,
              isSymbolicLink: () => false,
            },
          ]
        : directory === wide
          ? files
          : [],
    );

    expect(found).toHaveLength(70_000);
    expect(found.at(-1)).toBe(join(wide, "69999.lnk"));
  });

  it("扫描位置覆盖开始菜单与桌面", () => {
    const roots = productShortcutRoots({
      APPDATA: "C:\\Users\\x\\AppData\\Roaming",
      USERPROFILE: "C:\\Users\\x",
    } as NodeJS.ProcessEnv);
    expect(roots).toEqual([
      "C:\\Users\\x\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs",
      "C:\\Users\\x\\Desktop",
    ]);
    expect(productShortcutRoots({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("拒绝清理不是安装目录的路径", () => {
    const localAppData = "C:\\Users\\x\\AppData\\Local";
    expect(() =>
      assertSafeInstallRoot(`${localAppData}\\AyanamiTaskManagerDesktop`, localAppData),
    ).not.toThrow();
    // 路径来自环境变量；环境变量出错时 rm -rf 的代价和拼错的路径一样大。
    expect(() => assertSafeInstallRoot(localAppData, localAppData)).toThrow(/拒绝清理/u);
    expect(() =>
      assertSafeInstallRoot(`C:\\Program Files\\AyanamiTaskManagerDesktop`, localAppData),
    ).toThrow(/拒绝清理/u);
  });

  // 发布脚本负责卸载后清理，distribution-smoke 负责在验收前断言干净。两边各存
  // 一份「快捷方式在哪」的清单，就会出现清理漏了一处、验收却查得到——1.0.5 那次
  // 跑完九个阶段才在第十阶段的前置条件上倒掉。
  it("只有 product-install-sites 知道快捷方式在哪", () => {
    const scriptsDir = join(process.cwd(), "scripts");
    const files = readdirSync(scriptsDir).filter((name) => name.endsWith(".ts"));
    // 扫不到文件同样会让断言空转成绿，先把扫描面本身钉住。
    expect(files.length).toBeGreaterThan(5);
    const hardcoded = files.filter((name) =>
      readFileSync(join(scriptsDir, name), "utf8").includes("Start Menu"),
    );
    expect(hardcoded).toEqual(["product-install-sites.ts"]);
  });
});

describe("卸载标记", () => {
  // distribution-smoke 走完一整轮装—验—卸会留下 .dead，紧接着的就地更新把
  // app-<version> 铺回来却不清它，于是「已卸载」标记贴在活着的安装上，
  // 下一轮快速路径的 Update.exe 要对着这个自相矛盾的状态跑。
  it("有对应版本目录时清除 .dead，没有时保留", () => {
    const installRoot = mkdtempSync(join(tmpdir(), "atm-dead-"));
    temporary.push(installRoot);
    writeFileSync(join(installRoot, ".dead"), "", "utf8");

    // 没有 app-<version>：.dead 是准确的，不能动。
    expect(clearStaleDeadMarker(installRoot, "9.9.9")).toBe(false);
    expect(existsSync(join(installRoot, ".dead"))).toBe(true);

    mkdirSync(join(installRoot, "app-9.9.9"), { recursive: true });
    expect(clearStaleDeadMarker(installRoot, "9.9.9")).toBe(true);
    expect(existsSync(join(installRoot, ".dead"))).toBe(false);
    // 幂等：已经清过就不再报「清了」。
    expect(clearStaleDeadMarker(installRoot, "9.9.9")).toBe(false);
  });
});

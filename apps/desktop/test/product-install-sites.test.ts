import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSafeInstallRoot,
  findProductShortcuts,
  productShortcutRoots,
  removeProductShortcuts,
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

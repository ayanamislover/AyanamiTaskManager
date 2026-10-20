import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSystemTar, resolveSystemTool } from "../../../scripts/system-tar.js";

const scriptsRoot = join(process.cwd(), "scripts");

// 命令名写成裸 "tar"/"tar.exe" 就等于把命中谁交给 PATH；Git/MSYS2 的 GNU tar 排在
// System32 之前时会把盘符当远端主机名，发布脚本解压当场失败。whoami 同理（coreutils 的
// whoami 不认 `/logonid`），find、sort、timeout、hostname 也都和 Git 的 usr/bin 撞名。
const bareSystemToolInvocation =
  /(?:run|spawnSync|execFileSync|spawn|execFile)\(\s*"(?:tar|whoami|find|sort|timeout|hostname)(?:\.exe)?"/u;

describe("发布脚本的系统工具解析", () => {
  it("在 Windows 上钉到 System32 的 bsdtar，而不是 PATH 上的任意 tar", () => {
    expect(resolveSystemTar("win32", "C:\\Windows", () => true)).toBe(
      "C:\\Windows\\System32\\tar.exe",
    );
    expect(resolveSystemTar("win32", "D:\\Win", () => true)).toBe("D:\\Win\\System32\\tar.exe");
  });

  it("System32 没有 tar 时才退回 PATH，非 Windows 用 tar", () => {
    expect(resolveSystemTar("win32", "C:\\Windows", () => false)).toBe("tar.exe");
    expect(resolveSystemTar("linux", undefined, () => false)).toBe("tar");
  });

  it("whoami 同样钉到 System32", () => {
    expect(resolveSystemTool("whoami", "win32", "C:\\Windows", () => true)).toBe(
      "C:\\Windows\\System32\\whoami.exe",
    );
    expect(resolveSystemTool("whoami", "win32", "C:\\Windows", () => false)).toBe("whoami.exe");
  });

  it("scripts 下不得再出现依赖 PATH、会和 Git 撞名的裸系统工具调用", () => {
    const files = readdirSync(scriptsRoot).filter((name) => name.endsWith(".ts"));
    // 扫不到文件同样会让断言空转成绿，先把扫描面本身钉住。
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((name) =>
      bareSystemToolInvocation.test(readFileSync(join(scriptsRoot, name), "utf8")),
    );
    expect(offenders).toEqual([]);
    // 阳性对照：正则写错就会永远返回空数组、永远绿。
    expect(bareSystemToolInvocation.test('run("tar.exe", ["-xf", zip, "-C", root]);')).toBe(true);
    expect(bareSystemToolInvocation.test('spawnSync("tar", ["-xf", zip]);')).toBe(true);
    expect(bareSystemToolInvocation.test('spawnSync("whoami.exe", ["/logonid"], {')).toBe(true);
    expect(bareSystemToolInvocation.test('spawnSync(resolveSystemTool("whoami"), [')).toBe(false);
  });
});

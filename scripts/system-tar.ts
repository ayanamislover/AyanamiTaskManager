import { existsSync } from "node:fs";
import { join } from "node:path";

// Windows 自带的 tar.exe 是 bsdtar，能正确处理 `R:\Project\a.zip` 这类盘符路径。
// 但 Git for Windows / MSYS2 会把 GNU tar 装进 PATH 且排在 System32 之前，而 GNU tar
// 把冒号前的部分当远端主机名解析，遇到盘符路径直接 `tar: Cannot connect to R: resolve
// failed`。命中哪一个完全取决于 PATH 顺序，所以发布脚本不能调裸 "tar.exe"。
export function resolveSystemTar(
  platform: NodeJS.Platform = process.platform,
  systemRoot: string | undefined = process.env.SystemRoot,
  exists: (path: string) => boolean = existsSync,
): string {
  return resolveSystemTool("tar", platform, systemRoot, exists);
}

// 同一个坑不止 tar：Git 的 usr/bin 里还有 coreutils 的 whoami（不认 `/logonid`，W8 关口上
// lifecycle-smoke 从 Git Bash 拉起时因此拿不到登录 SID）、find、sort、timeout、hostname。
// Windows 自带的这几样一律从 System32 取。
export function resolveSystemTool(
  name: string,
  platform: NodeJS.Platform = process.platform,
  systemRoot: string | undefined = process.env.SystemRoot,
  exists: (path: string) => boolean = existsSync,
): string {
  if (platform !== "win32") return name;
  const bundled = join(systemRoot ?? "C:\\Windows", "System32", `${name}.exe`);
  return exists(bundled) ? bundled : `${name}.exe`;
}

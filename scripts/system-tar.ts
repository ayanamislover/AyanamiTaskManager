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
  if (platform !== "win32") return "tar";
  const bundled = join(systemRoot ?? "C:\\Windows", "System32", "tar.exe");
  return exists(bundled) ? bundled : "tar.exe";
}

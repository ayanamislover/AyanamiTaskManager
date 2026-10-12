/**
 * 把 output/package 里的生产便携 zip 解到一个固定的沙箱目录，返回其中的宿主 exe。
 * budget-measure 与 power-loss-drill 量的、杀的都是这份——它就是候选（L6 拿它的哈希对）。
 * zip 的 sha256 变了才重新解；同名同大小的新构建不会被当成旧的。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";

export function unpackPortable(packageDir: string, portableRoot: string): string {
  const zip = readdirSync(packageDir).find((name) => name.endsWith("-portable.zip"));
  if (!zip) throw new Error(`${packageDir} 里没有便携 zip`);
  const bytes = readFileSync(join(packageDir, zip));
  const marker = join(portableRoot, "source.json");
  const source = JSON.stringify({ zip, sha256: createHash("sha256").update(bytes).digest("hex") });
  const stale = !existsSync(marker) || readFileSync(marker, "utf8") !== source;
  if (stale) {
    rmSync(portableRoot, { recursive: true, force: true, maxRetries: 2 });
    for (const [name, content] of Object.entries(unzipSync(bytes))) {
      if (name.endsWith("/")) continue;
      const target = join(portableRoot, ...name.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    writeFileSync(marker, source);
  }
  const folder = readdirSync(portableRoot).find((name) => name.startsWith("AyanamiTaskManager-"));
  if (!folder) throw new Error("便携 zip 里没有版本目录");
  if (!existsSync(join(portableRoot, folder, "portable")))
    throw new Error("便携目录缺 portable 标记");
  return join(portableRoot, folder, "AyanamiTaskManager.exe");
}

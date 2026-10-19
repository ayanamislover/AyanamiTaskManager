import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/**
 * 一个目录下全部文件的 SHA-256：每个文件写成「相对路径|哈希」，按路径排好再合成一个摘要。
 * 文件改了、多了、少了、改了名，摘要都会变；与遍历顺序无关。
 */
export async function treeDigest(root: string): Promise<{ files: number; sha256: string }> {
  const lines: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else
        lines.push(`${relative(root, path).split(sep).join("/")}|${sha256(await readFile(path))}`);
    }
  };
  await walk(root);
  lines.sort();
  return { files: lines.length, sha256: sha256(Buffer.from(lines.join("\n"), "utf8")) };
}

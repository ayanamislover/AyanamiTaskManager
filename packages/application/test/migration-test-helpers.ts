import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export function removeMigrationsAfter(
  migrationsRoot: string,
  scope: "registry" | "project",
  targetVersion: number,
): string[] {
  const directory = join(migrationsRoot, scope);
  const removed: string[] = [];
  for (const name of readdirSync(directory)) {
    const match = /^(\d{4})_.+\.sql$/u.exec(name);
    if (match && Number(match[1]) > targetVersion) {
      rmSync(join(directory, name));
      removed.push(name);
    }
  }
  return removed.sort();
}

import { mkdirSync, mkdtempSync, existsSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  reclaimSmokeWorkspaces,
  SMOKE_WORKSPACE_RETENTION_MS,
} from "../../../scripts/smoke-workspace.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 8 });
});

const PREFIX = "packaged-smoke-agent-config-";
const now = Date.UTC(2026, 8, 14, 12, 0, 0);
const stale = (now - SMOKE_WORKSPACE_RETENTION_MS - 60_000) / 1000;

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "atm-smoke-workspace-"));
  roots.push(root);
  return root;
}

function directory(root: string, name: string, ageSeconds = stale) {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "marker.log"), "x");
  utimesSync(path, ageSeconds, ageSeconds);
  return path;
}

describe("smoke 合成 home 的回收", () => {
  it("只清过期的同前缀兄弟目录，放过本次运行、新目录和别的前缀", async () => {
    const root = workspace();
    const old = directory(root, `${PREFIX}old`);
    const mine = directory(root, `${PREFIX}mine`);
    const fresh = directory(root, `${PREFIX}fresh`, (now - 60_000) / 1000);
    const unrelated = directory(root, "packaged-smoke-data");

    const reclaimed = await reclaimSmokeWorkspaces({
      directory: root,
      prefix: PREFIX,
      keep: [mine],
      now,
    });

    expect(reclaimed).toEqual([old]);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(mine)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });

  it("一个目录删不掉，不影响回收其余目录", async () => {
    const root = workspace();
    // 占用要靠注入：Node 自己开的句柄带 FILE_SHARE_DELETE，在 Windows 上挡不住
    // rm（实测 rm 直接成功），拿真句柄根本造不出删不掉的目录。早先那版用真句柄，
    // 结果是创建 held.log 把目录 mtime 刷新了，locked 因为「看起来新」才活下来——
    // 用例名说的是占用，真正生效的是保留期，全绿但什么都没钉住。
    const locked = directory(root, `${PREFIX}locked`);
    const other = directory(root, `${PREFIX}other`);
    const attempted: string[] = [];

    const reclaimed = await reclaimSmokeWorkspaces({
      directory: root,
      prefix: PREFIX,
      now,
      remove: async (path) => {
        attempted.push(path);
        if (path === locked) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
        await rm(path, { recursive: true, force: true, maxRetries: 3 });
      },
    });

    // 阳性对照：两个都得真的被尝试过，否则下面那条只是在说「没轮到它」。
    expect(attempted).toEqual([locked, other]);
    expect(reclaimed).toEqual([other]);
    expect(existsSync(locked)).toBe(true);
    expect(existsSync(other)).toBe(false);
  });

  it("目录不存在时安静返回，不让 smoke 因为清理失败而起不来", async () => {
    await expect(
      reclaimSmokeWorkspaces({ directory: join(workspace(), "missing"), prefix: PREFIX, now }),
    ).resolves.toEqual([]);
  });
});

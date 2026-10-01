import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AyanamiDatabaseManager } from "../src/index.js";

const roots: string[] = [];
const managers: AyanamiDatabaseManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// 设置页一打开就跑 doctor：每个项目库 quick_check + foreign_key_check 都要把整库读一遍。
// 连着同步查完所有库会把事件循环堵上好几秒，期间别的请求全在排队，界面看上去整个卡住。
describe("doctor 不一口气堵住事件循环", () => {
  it("每查完一个项目库让出一次：别的宏任务能在中间插进来，结果照旧完整", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atm-doctor-yield-"));
    roots.push(dataDir);
    const manager = await AyanamiDatabaseManager.open({
      dataDir,
      migrationsRoot: resolve(process.cwd(), "migrations"),
    });
    managers.push(manager);
    for (const code of ["DYA", "DYB", "DYC"])
      await manager.createProject({ name: code, sourcePath: null, code });

    let settled = false;
    const pending = manager.doctor().then((result) => {
      settled = true;
      return result;
    });
    const interleaved = await new Promise<boolean>((done) => setImmediate(() => done(!settled)));
    expect(interleaved).toBe(true);
    const result = await pending;
    expect(result.projects.map((project) => project.code).sort()).toEqual(["DYA", "DYB", "DYC"]);
    expect(result.projects.every((project) => project.ok)).toBe(true);
  });
});

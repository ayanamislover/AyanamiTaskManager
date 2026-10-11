import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostEnvironment } from "../../../scripts/distribution-common.js";
import { KEEPALIVE_TASK } from "../../../scripts/distribution-installed.js";

// ATM-R-475：distribution-smoke 的安装那一半写真实的卸载项、开始菜单与任务计划程序。
// 便携那一半必须在任何机器上都只碰 output/，安装那一半只在声明过的干净机器上才加载。
const read = (name: string) => readFileSync(join(process.cwd(), "scripts", name), "utf8");

const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

describe("distribution-smoke 的两半", () => {
  it("安装那一半只在声明干净机器之后动态加载，没有静态导入", () => {
    const source = read("distribution-smoke.ts");
    expect(source).not.toMatch(/from "\.\/distribution-installed\.js"/u);
    const gate = source.indexOf("if (!cleanMachine) {");
    const load = source.indexOf('await import("./distribution-installed.js")');
    expect(gate).toBeGreaterThan(0);
    expect(load).toBeGreaterThan(gate);
    expect(source).toContain('process.env.ATM_DISTRIBUTION_CLEAN_MACHINE === "1"');
  });

  it("便携那一半把 L 与 N 都放在 output/ 下，并核对真实的 N 没被碰过", () => {
    const source = read("distribution-smoke.ts");
    expect(source).toContain('const roots = { l: join(dataDir, "L"), n: join(dataDir, "N") };');
    expect(source).toContain('productionChecks("portable", executable, roots)');
    expect(source).toContain("realHostPid() !== hostPid");
  });

  it("隔离运行显式给出两个根；产品默认运行去掉所有数据根覆盖", () => {
    process.env.ATM_DATA_DIR = "C:\\elsewhere\\L";
    process.env.AYANAMI_TASK_DATA_DIR = "C:\\elsewhere\\legacy";
    process.env.ATM3_DATA_DIR = "C:\\elsewhere\\N";
    const isolated = hostEnvironment({ l: "C:\\sandbox\\L", n: "C:\\sandbox\\N" });
    expect(isolated.ATM_DATA_DIR).toBe("C:\\sandbox\\L");
    expect(isolated.ATM3_DATA_DIR).toBe("C:\\sandbox\\N");
    expect(isolated.AYANAMI_TASK_DATA_DIR).toBeUndefined();
    const product = hostEnvironment({ l: null, n: "C:\\real\\N" });
    for (const key of ["ATM_DATA_DIR", "AYANAMI_TASK_DATA_DIR", "ATM3_DATA_DIR"])
      expect(product[key], key).toBeUndefined();
    expect(product.PATH ?? product.Path).toBeTruthy();
  });

  it("安装前逐项核对机器干净：两个数据根、安装、登记、自启值与保活任务", () => {
    const source = read("distribution-installed.ts");
    const install = source.indexOf('run(setup, ["install"');
    for (const trace of [
      "existsSync(realL) && realL",
      "existsSync(realN) && realN",
      "uninstallRegistrationExists() && uninstallRegistryKey",
      "keepaliveTask() !== null && `计划任务 ${KEEPALIVE_TASK}`",
    ]) {
      expect(source.indexOf(trace), trace).toBeGreaterThan(0);
      expect(source.indexOf(trace), trace).toBeLessThan(install);
    }
    expect(source).toContain(
      'check("卸载后保活任务已移除", keepaliveTask() === null, KEEPALIVE_TASK);',
    );
    // 保活任务只读查询，不登记、不删除。
    expect(source).not.toMatch(/schtasks\.exe", \["\/(?:create|delete|change|run)/iu);
  });

  it("保活任务名与 install-state 的 TASK_NAME 一致", () => {
    const rust = readFileSync(
      join(process.cwd(), "apps/desktop/native/install-state/src/keepalive.rs"),
      "utf8",
    );
    const name = /pub const TASK_NAME: &str = "([^"]+)";/u.exec(rust)?.[1];
    expect(name).toBeTruthy();
    expect(KEEPALIVE_TASK).toBe(name);
  });
});

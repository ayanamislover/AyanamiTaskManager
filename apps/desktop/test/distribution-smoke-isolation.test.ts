import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DECOY_VARIABLES,
  decoyEnvironment,
  hostEnvironment,
  probeValue,
  scrubbedVariables,
} from "../../../scripts/distribution-common.js";
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
    // 任何形式的静态导入（含无绑定的副作用导入、再导出）都不行。
    expect(source).not.toMatch(
      /^\s*(?:import|export)\b[^;]*?["']\.\/distribution-installed(?:\.js)?["']/mu,
    );
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
    expect(isolated.LOCALAPPDATA).toBe("C:\\sandbox\\LocalAppData");
    // 继承来的同名变量（不论大小写）只剩一份。
    expect(Object.keys(isolated).filter((key) => key.toUpperCase() === "LOCALAPPDATA")).toEqual([
      "LOCALAPPDATA",
    ]);
    const product = hostEnvironment({ l: null, n: "C:\\real\\N" });
    for (const key of ["ATM_DATA_DIR", "AYANAMI_TASK_DATA_DIR", "ATM3_DATA_DIR"])
      expect(product[key], key).toBeUndefined();
    expect(product.LOCALAPPDATA).toBe(process.env.LOCALAPPDATA);
    // 外面以别的大小写设的数据根变量同样去掉（Windows 上是同一个变量）。
    delete process.env.ATM3_DATA_DIR;
    process.env.Atm3_Data_Dir = "C:\\elsewhere\\N";
    const cased = hostEnvironment({ l: null, n: "C:\\real\\N" });
    expect(Object.keys(cased).filter((key) => key.toUpperCase() === "ATM3_DATA_DIR")).toEqual([]);
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

  it("窗口探测失败一律抛出，不当作「没有窗口 / 没有激活」（W8 r8 P2-03）", () => {
    const ok = { status: 0, stdout: "0\r\n", stderr: "" };
    expect(probeValue("Activated(1)", ok)).toBe(0);
    expect(probeValue("Count(1)", { ...ok, stdout: "2\n" })).toBe(2);
    for (const failed of [
      { ...ok, stdout: "" },
      { ...ok, stdout: "-1" },
      { ...ok, stdout: "NaN" },
      { ...ok, stdout: "0\nAdd-Type : 编译错误" },
      { ...ok, status: 1 },
      { ...ok, status: null, error: new Error("spawn powershell.exe ENOENT") },
    ]) {
      expect(() => probeValue("Activated(1)", failed)).toThrow(/窗口探测 Activated\(1\) 失败/u);
    }
  });

  // W8 关口 peer r15 P2-01：安装态的宿主由 setup 的事务 START 拉起，productionChecks 只是直接用它。
  // 诱饵必须在 setup 拉起之前交给它，并由宿主自己记下已清掉，否则「注入无效」两条可以在没注入时变绿。
  it("安装半把注入的 WebView2 变量交给 atm-setup install，并凭 host.log 确认送到了宿主", () => {
    const installed = read("distribution-installed.ts");
    expect(installed).toContain(
      'const installEnv = decoyEnvironment("installed", { l: null, n: realN }).env;',
    );
    expect(installed).toContain('run(setup, ["install", manifest, "--quiet"], installEnv)');
    const common = read("distribution-common.ts");
    expect(common).toContain("const { env, decoy } = decoyEnvironment(label, roots);");
    expect(common).toContain("DECOY_VARIABLES.every((name) => scrubbed.includes(name))");

    const { env, decoy } = decoyEnvironment("installed", { l: null, n: "C:\\real\\N" });
    for (const name of DECOY_VARIABLES) expect(env[name], name).toBeTruthy();
    expect(env.WEBVIEW2_USER_DATA_FOLDER).toBe(decoy);
    expect(env.ATM3_DATA_DIR).toBeUndefined();

    // 宿主写的行：`<秒> pid=<pid> scrubbed from the environment: <名字>, …`（host/src/main.rs）。
    const host = readFileSync(join(process.cwd(), "apps/desktop/native/host/src/main.rs"), "utf8");
    expect(host).toContain('"{secs} pid={} {}\\n"');
    expect(host).toContain('&format!("scrubbed from the environment: {}", scrubbed.join(", ")),');
    const log =
      "1 pid=7 scrubbed from the environment: WEBVIEW2_USER_DATA_FOLDER\r\n" +
      "2 pid=9 scrubbed from the environment: WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, WEBVIEW2_USER_DATA_FOLDER\n";
    expect(scrubbedVariables(log, 9)).toEqual([...DECOY_VARIABLES]);
    expect(scrubbedVariables(log, 7)).toEqual(["WEBVIEW2_USER_DATA_FOLDER"]);
    expect(scrubbedVariables(log, 77)).toEqual([]);
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

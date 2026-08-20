import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeAppProcesses, parseTasklistCsv } from "../../../scripts/app-processes.js";

const scriptsRoot = join(process.cwd(), "scripts");

// check 的第三个参数是失败时唯一会被打印的东西。进程类检查若直接把布尔量交上去，
// 报错就只剩「未通过」，看不出是谁占着——发布卡住时这句话等于没说。
const bareProcessCheck = /check\(\s*[`"'][^`"']*进程/u;

const tasklistOutput = [
  '"AyanamiTaskManager.exe","972","Console","1","185,236 K"',
  '"AyanamiTaskManager.exe","46664","Console","1","96,512 K"',
].join("\r\n");

describe("发布验收的同名进程诊断", () => {
  it("解析 tasklist CSV，并忽略无匹配时的本地化提示行", () => {
    expect(parseTasklistCsv(tasklistOutput)).toEqual([
      { imageName: "AyanamiTaskManager.exe", pid: 972 },
      { imageName: "AyanamiTaskManager.exe", pid: 46664 },
    ]);
    expect(parseTasklistCsv("信息: 没有运行的任务匹配指定标准。")).toEqual([]);
    expect(
      parseTasklistCsv("INFO: No tasks are running which match the specified criteria."),
    ).toEqual([]);
  });

  it("失败信息必须给出 PID，并指出同名的多半是 MCP stdio 桥", () => {
    const detail = describeAppProcesses(parseTasklistCsv(tasklistOutput));
    expect(detail).toContain("972");
    expect(detail).toContain("46664");
    expect(detail).toContain("MCP stdio");
    expect(describeAppProcesses([])).toBe("");
  });

  it("scripts 下不得再出现不带 detail 的进程类 check", () => {
    const files = readdirSync(scriptsRoot).filter((name) => name.endsWith(".ts"));
    // 扫不到文件同样会让断言空转成绿，先把扫描面本身钉住。
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((name) =>
      bareProcessCheck.test(readFileSync(join(scriptsRoot, name), "utf8")),
    );
    expect(offenders).toEqual([]);
    // 阳性对照：正则写错就会永远返回空数组、永远绿。
    expect(bareProcessCheck.test('check("卸载后应用进程已退出", !appProcessIsRunning());')).toBe(
      true,
    );
    expect(bareProcessCheck.test("check(`${name}没有运行中的应用进程`, !running);")).toBe(true);
  });
});

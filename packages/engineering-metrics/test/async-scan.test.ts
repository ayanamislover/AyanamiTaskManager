import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withTemporaryDirectory } from "@ayanami-task/testing";
import { scanProjectMetrics, scanWorkItemChanges } from "../src/index.js";

function git(directory: string, args: string[]): void {
  execFileSync("git", args, { cwd: directory, stdio: "ignore", windowsHide: true });
}

function seed(directory: string): void {
  mkdirSync(join(directory, "src"), { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ dependencies: { react: "1" } }));
  for (let index = 0; index < 20; index += 1) {
    writeFileSync(join(directory, "src", `mod-${index}.ts`), `export const value = ${index};\n`);
  }
  git(directory, ["init"]);
  git(directory, ["config", "user.email", "atm@example.test"]);
  git(directory, ["config", "user.name", "ATM Test"]);
  git(directory, ["add", "-A"]);
  git(directory, ["commit", "-m", "baseline"]);
}

/** 扫描期间每 5ms 敲一次；同步实现下这些回调只能排到扫描结束之后，那时已经 clearInterval。 */
async function ticksDuring(run: () => Promise<unknown>): Promise<number> {
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 5);
  try {
    await run();
  } finally {
    clearInterval(timer);
  }
  return ticks;
}

describe("工程统计扫描不占住事件循环", () => {
  /**
   * 这是整件事的要害。扫描要跑一串 git 子进程，本仓实测同步版 scanWorkItemChanges 1626ms、
   * scanProjectMetrics 1289ms——那段时间 daemon 一个请求都答不了，点开任务详情、改任务状态
   * 慢的都不是那件事本身，而是它排在扫描后面。
   */
  it("扫描进行中定时器照常触发", async () => {
    await withTemporaryDirectory("metrics-event-loop", async (directory) => {
      seed(directory);
      expect(await ticksDuring(() => scanProjectMetrics(directory))).toBeGreaterThan(0);
      expect(
        await ticksDuring(async () =>
          scanWorkItemChanges(directory, (await scanProjectMetrics(directory)).head),
        ),
      ).toBeGreaterThan(0);
    });
  });

  /**
   * 上一条只看得住已有的两个入口。这条拦住往回写：新加一处同步子进程或同步读整个文件，
   * 事件循环就又被占住，而调用方通常察觉不到——它只是「有点慢」。
   *
   * existsSync / realpathSync 这类只摸一下元数据的调用不在此列，量级差着三个数量级。
   */
  it("源码里不再有同步子进程或同步读文件", () => {
    const root = join(process.cwd(), "packages", "engineering-metrics", "src");
    const sources = readdirSync(root).filter((entry) => entry.endsWith(".ts"));
    // 正则写错就永远返回空数组、永远绿，所以先确认真的读到了源码。
    expect(sources.length).toBeGreaterThan(1);
    const offenders: string[] = [];
    for (const entry of sources) {
      readFileSync(join(root, entry), "utf8")
        .split(/\r?\n/u)
        .forEach((line, index) => {
          if (/\b(?:execFileSync|spawnSync|execSync|readFileSync|writeFileSync)\s*\(/u.test(line)) {
            offenders.push(`src/${entry}:${index + 1}`);
          }
        });
    }
    expect(
      offenders,
      "扫描跑在 daemon 的事件循环上，同步子进程/同步读文件会把它整段停住；用 node:fs/promises 和 git-command.ts 里的异步 runner。",
    ).toEqual([]);
  });
});

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { BUDGET_PROBE, EXITED_STATES, type ProcessTree } from "../../../scripts/budget-probe.js";
import { powershellScratch } from "../../../scripts/powershell-scratch.js";

/** 起一个真探针，按行问答；结束时连同临时根一起收掉。 */
async function withProbe(run: (ask: (command: string) => Promise<string>) => Promise<void>) {
  const scratch = powershellScratch();
  const probe = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", BUDGET_PROBE],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: scratch.env },
  );
  let stderr = "";
  probe.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const waiting: Array<(line: string) => void> = [];
  let ready!: () => void;
  const isReady = new Promise<void>((done) => (ready = done));
  createInterface({ input: probe.stdout }).on("line", (line) =>
    line === "ready" ? ready() : waiting.shift()?.(line),
  );
  const ask = (command: string) =>
    new Promise<string>((done) => {
      waiting.push(done);
      probe.stdin.write(`${command}\n`);
    });
  try {
    await Promise.race([
      isReady,
      new Promise((_, fail) => probe.once("exit", () => fail(new Error(`探针没起来：${stderr}`)))),
    ]);
    await run(ask);
  } finally {
    probe.stdin.end();
    if (probe.exitCode === null) await new Promise((done) => probe.once("exit", done));
    expect(scratch.dispose()).toBe(true);
  }
}

describe("预算探针（真编译、真跑）", () => {
  it.runIf(process.platform === "win32")(
    "认得出自己拉起的进程树；只结束出生时间对得上的那个进程；查不了的不算已退出",
    async () => {
      // 父 node（只等着）→ 子 node（只等着）
      const parent = spawn(
        process.execPath,
        [
          "-e",
          "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1e3)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1e3)",
        ],
        { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
      );
      try {
        const childPid = Number(
          await new Promise<string>((done) =>
            parent.stdout.once("data", (data) => done(String(data).trim())),
          ),
        );
        await withProbe(async (ask) => {
          const tree = JSON.parse(await ask(`tree ${parent.pid}`)) as ProcessTree;
          expect(tree.unknown).toEqual([]);
          const child = tree.rows.find((row) => row.pid === childPid)!;
          expect(child).toMatchObject({ ppid: parent.pid, exe: "node.exe" });
          expect(child.ws).toBeGreaterThan(0);
          expect(child.ticks).toMatch(/^\d{17,}$/u);
          // 不存在的根：空树，不是失败。
          expect(JSON.parse(await ask("tree 4294960"))).toEqual({ rows: [], unknown: [] });
          const otherTicks = String(BigInt(child.ticks) + 1n);
          expect(await ask(`alive ${child.pid} ${child.ticks}`)).toBe("same");
          expect(await ask(`alive ${child.pid} ${otherTicks}`)).toBe("other");
          // PID 上不是记下的那个进程（出生时间不同）：不动它。
          expect(await ask(`killsame ${child.pid} ${otherTicks}`)).toBe("other");
          expect(await ask(`alive ${child.pid} ${child.ticks}`)).toBe("same");
          expect(await ask(`killsame ${child.pid} ${child.ticks}`)).toBe("killed");
          await expect
            .poll(() => ask(`alive ${child.pid} ${child.ticks}`), { timeout: 10_000 })
            .toBe("gone");
          // 协议错误不是「已退出」。
          const garbage = await ask("alive x y");
          expect(garbage).toBe("null");
          expect(EXITED_STATES.has(garbage)).toBe(false);
          expect([...EXITED_STATES].sort()).toEqual(["gone", "other"]);
        });
      } finally {
        parent.kill();
      }
    },
    90_000,
  );

  // 进程树身份（Codex R7-P2-3/4）：成员与出生时间在同一个句柄上取，快照之后出生的（PID 被复用）
  // 与早于父进程出生的都排除；查不了的单列 unknown，不悄悄丢掉。这几条无法在真机上稳定造出来，
  // 守住源码里的判定。
  it("树成员按快照时间与父进程出生时间认人，查不了的单列", () => {
    const source = readFileSync("scripts/budget-probe.ts", "utf8");
    const snapshot = source.indexOf("CreateToolhelp32Snapshot(2, 0);");
    const taken = source.indexOf("DateTime taken = DateTime.UtcNow;");
    expect(snapshot).toBeGreaterThan(0);
    expect(taken).toBeGreaterThan(snapshot);
    expect(source).toContain("if (birth > taken || birth < started[tree[index]])");
    expect(source).toContain('if (state == "unknown") { unknown.Add(child); continue; }');
    expect(source).toContain("catch { unknown.Add(pid); continue; }");
    expect(source).toContain("IntPtr pinned = process.Handle;");
    expect(source).not.toMatch(/catch \{ \}/u);
    expect(source).not.toContain("DateTime.MaxValue");
    const budget = readFileSync("scripts/budget-measure.ts", "utf8");
    expect(budget).toContain('if (line === "null") throw new Error(');
    expect(budget).toContain("summarize(await probe.measuredTree(hostPid)");
    expect(budget).toContain("states.every((state) => EXITED_STATES.has(state))");
    expect(budget).toContain("const gone = left && tree !== null && unlisted === 0;");
    expect(budget).not.toMatch(/state === "unknown"/u);
  });
});

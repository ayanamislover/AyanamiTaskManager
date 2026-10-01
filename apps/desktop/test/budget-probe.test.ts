import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import {
  BUDGET_PROBE,
  buildProcessTree,
  descendantsExited,
  EXITED_STATES,
  requireExitConfirmed,
  type RawProcessTree,
} from "../../../scripts/budget-probe.js";
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
          const tree = buildProcessTree(
            JSON.parse(await ask(`tree ${parent.pid}`)) as RawProcessTree,
            parent.pid!,
          );
          expect(tree.unmeasured).toEqual([]);
          expect(tree.unknown).toEqual([]);
          const child = tree.rows.find((row) => row.pid === childPid)!;
          expect(child).toMatchObject({ ppid: parent.pid, exe: "node.exe" });
          expect(child.ws).toBeGreaterThan(0);
          expect(child.ticks).toMatch(/^\d{17,}$/u);
          // 不存在的根：空树，不是失败。
          const missing = JSON.parse(await ask("tree 4294960")) as RawProcessTree;
          expect(missing.members).toEqual([]);
          expect(buildProcessTree(missing, 4294960)).toEqual({
            rows: [],
            unknown: [],
            unmeasured: [],
          });
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

  // 进程树身份（Codex R7-P2-3/4、R8-P2-1/2）：判定是纯函数，直接拿竞态数据做回归。
  describe("buildProcessTree", () => {
    const member = (
      pid: number,
      ppid: number,
      ticks: number | null,
      extra: Partial<RawProcessTree["members"][number]> = {},
    ): RawProcessTree["members"][number] => ({
      pid,
      ppid,
      exe: "x.exe",
      state: "ok",
      ticks: ticks === null ? null : String(ticks),
      ws: 10,
      priv: 20,
      ...extra,
    });

    it("快照前界限之后出生的（PID 被复用）记为查不了，不当成员", () => {
      // R8 反例：父出生 100、快照前界限 200、PID 被复用的新对象出生 250。旧做法在快照之后才取
      // 时间（300），会把它认成子孙，之后 KillSame 核对 ticks 也对得上，就结束了无关进程。
      const tree = buildProcessTree(
        { bound: "200", members: [member(1, 0, 100), member(2, 1, 250)] },
        1,
      );
      expect(tree.rows.map((row) => row.pid)).toEqual([1]);
      expect(tree.unknown).toEqual([2]);
      expect(descendantsExited(tree, [])).toBe(false);
    });

    it("早于父进程出生的不是子孙（父 PID 被复用过），排除且不展开", () => {
      const tree = buildProcessTree(
        { bound: "500", members: [member(1, 0, 300), member(2, 1, 100), member(3, 2, 400)] },
        1,
      );
      expect(tree.rows.map((row) => row.pid)).toEqual([1]);
      expect(tree.unknown).toEqual([]);
    });

    it("根查不了身份：整棵树不完整，不能确认子孙已退出", () => {
      // R8-P2-2：旧做法把根从 unknown 里滤掉，空子孙列表就成了「全部退出」。
      const tree = buildProcessTree(
        { bound: "500", members: [member(1, 0, null, { state: "unknown" }), member(2, 1, 300)] },
        1,
      );
      expect(tree).toEqual({ rows: [], unknown: [1], unmeasured: [] });
      expect(descendantsExited(tree, [])).toBe(false);
    });

    it("查不了的子孙单列且不展开；已退出的不算成员也不算查不了", () => {
      const tree = buildProcessTree(
        {
          bound: "500",
          members: [
            member(1, 0, 100),
            member(2, 1, null, { state: "unknown" }),
            member(3, 2, 300),
            member(4, 1, null, { state: "gone" }),
            member(5, 1, 200),
          ],
        },
        1,
      );
      expect(tree.rows.map((row) => row.pid)).toEqual([1, 5]);
      expect(tree.unknown).toEqual([2]);
    });

    it("身份确认但内存读不到：仍是成员（收尾要等它），另列 unmeasured", () => {
      const tree = buildProcessTree(
        { bound: "500", members: [member(1, 0, 100), member(2, 1, 200, { ws: null, priv: null })] },
        1,
      );
      expect(tree.rows.find((row) => row.pid === 2)).toMatchObject({ ws: -1, priv: -1 });
      expect(tree.unmeasured).toEqual([2]);
      expect(tree.unknown).toEqual([]);
    });

    it("只有树查全了、每个子孙都明确 gone / other 才算确认退出", () => {
      const complete = buildProcessTree(
        { bound: "500", members: [member(1, 0, 100), member(2, 1, 200)] },
        1,
      );
      expect(descendantsExited(complete, ["gone"])).toBe(true);
      expect(descendantsExited(complete, ["other"])).toBe(true);
      expect(descendantsExited(complete, ["same"])).toBe(false);
      expect(descendantsExited(complete, ["unknown"])).toBe(false);
      expect(descendantsExited(complete, ["null"])).toBe(false);
      expect(descendantsExited(null, [])).toBe(false);
    });
  });

  // R8-P2-3：没确认退出就停止后续轮次，不再刷新、复用这一轮的数据目录。
  it("每轮保存退出证据之后确认，没确认就停", () => {
    expect(() => requireExitConfirmed("第 1 轮", { confirmed: false })).toThrow(/停止后续轮次/u);
    expect(() => requireExitConfirmed("第 1 轮", { confirmed: true })).not.toThrow();
    const budget = readFileSync("scripts/budget-measure.ts", "utf8");
    const main = budget.slice(budget.indexOf("await withLoginItemsRestored(async () => {"));
    // 四处收尾（内存、前台、后台、smoke）各确认一次，且都在保存证据之后。
    const confirms = [...main.matchAll(/requireExitConfirmed\(/gu)].map((match) => match.index!);
    expect(confirms).toHaveLength(4);
    for (const at of confirms) {
      expect(main.slice(0, at).trimEnd().endsWith("save();")).toBe(true);
    }
    // 收尾的结论来自纯函数，根不再被滤掉；宿主提前退出不算确认。
    expect(budget).toContain("const confirmed = descendantsExited(tree, states);");
    expect(budget).not.toMatch(/unknown\.filter\(\(pid\) => pid !== host\.pid\)/u);
    expect(budget).toMatch(/reply: "already-exited",\s*confirmed: false,/u);
    const probe = readFileSync("scripts/budget-probe.ts", "utf8");
    expect(probe.indexOf("long bound = DateTime.UtcNow.Ticks;")).toBeGreaterThan(0);
    expect(probe.indexOf("long bound = DateTime.UtcNow.Ticks;")).toBeLessThan(
      probe.indexOf("IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);"),
    );
  });
});

import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  defaultProcessIdentity,
  isPidAlive,
  type KillResult,
  killProcessTree,
  linuxProcessIdentity,
  parseFileTime,
  parseProcStatStartTime,
} from "../src/process.js";
import { checkProcessIdentity, type ProcessProbe } from "../src/process-identity.js";
import { winIdentity } from "./support.js";

const PID = 4_000_004;
const CREATED = new Date("2026-09-01T00:00:00.000Z");

/** 只读替身：核验身份绝不应该结束进程，调到 killTree 就让用例失败。 */
function probe(identity: string | null, alive = true): ProcessProbe & { kills: number } {
  const self = {
    kills: 0,
    isAlive: () => alive,
    identity: async () => identity,
    killTree: async (): Promise<KillResult> => {
      self.kills += 1;
      throw new Error("核验身份不应结束进程");
    },
  };
  return self;
}

describe("进程身份：出生标识精确相等，没有时间容差", () => {
  it.each([
    ["100ns", 1n],
    ["1ms", 10_000n],
    ["500ms", 5_000_000n],
    ["1000ms", 10_000_000n],
    ["-1ms", -10_000n],
  ] as const)("出生标识差 %s 就是另一个进程", async (_label, ticks) => {
    const live = probe(winIdentity(CREATED, ticks));
    expect(await checkProcessIdentity(live, PID, winIdentity(CREATED))).toBe("different");
    expect(live.kills).toBe(0);
  });

  it("逐字相同才是同一个；没记录、旧版 ISO、查不到都是未知；PID 不在是 gone", async () => {
    const born = winIdentity(CREATED);
    expect(await checkProcessIdentity(probe(born), PID, born)).toBe("same");
    expect(await checkProcessIdentity(probe(born), PID, undefined)).toBe("unknown");
    expect(await checkProcessIdentity(probe(born), PID, "")).toBe("unknown");
    // 旧版本存的 ISO 创建时间不会被当成标识读进来；即便被当成标识，也不可能与新格式相等。
    expect(await checkProcessIdentity(probe(born), PID, CREATED.toISOString())).toBe("different");
    expect(await checkProcessIdentity(probe(null), PID, born)).toBe("unknown");
    expect(await checkProcessIdentity(probe(born, false), PID, born)).toBe("gone");
  });

  it("Windows：只认 PowerShell 打印的 FILETIME 整数原值", () => {
    expect(parseFileTime("134350603228162864\r\n")).toBe("134350603228162864");
    for (const bad of ["", "2026-09-01T00:00:00.000Z", "1.3e17", "-5", "0", "12 34"])
      expect(parseFileTime(bad)).toBeNull();
  });

  it("Linux：/proc/<pid>/stat 第 22 字段，comm 里带空格和括号也数得对；再拼上开机 ID", () => {
    const tail = Array.from({ length: 50 }, (_, index) => String(index + 3));
    tail[22 - 3] = "987654321";
    const stat = `1234 (weird ) name (x)) S ${tail.slice(1).join(" ")}`;
    expect(parseProcStatStartTime(stat)).toBe("987654321");
    expect(parseProcStatStartTime("1234 no-parens S 1 2 3")).toBeNull();
    expect(parseProcStatStartTime("1234 (short) S 1 2")).toBeNull();
    const files: Record<string, string> = {
      "/proc/77/stat": stat,
      "/proc/sys/kernel/random/boot_id": "0f8fad5b-d9cb-469f-a165-70867728950e\n",
    };
    const read = (path: string) => {
      const text = files[path];
      if (text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return text;
    };
    expect(linuxProcessIdentity(77, read)).toBe(
      "linux:0f8fad5b-d9cb-469f-a165-70867728950e:987654321",
    );
    expect(linuxProcessIdentity(78, read)).toBeNull();
  });

  it("拿不到稳定出生标识的平台一律返回 null（身份未知，不接管不结束）", async () => {
    for (const platform of ["darwin", "freebsd", "aix"] as const)
      expect(await defaultProcessIdentity(process.pid, platform)).toBeNull();
    expect(await defaultProcessIdentity(0)).toBeNull();
  });

  it("默认探测（只读）：当前进程两次读到的标识逐字相同，死进程返回 null", async () => {
    const first = await defaultProcessIdentity(process.pid);
    const second = await defaultProcessIdentity(process.pid);
    if (process.platform === "win32") expect(first).toMatch(/^win32:\d+$/u);
    else if (process.platform === "linux") expect(first).toMatch(/^linux:[0-9a-f-]+:\d+$/u);
    else expect(first).toBeNull();
    expect(second).toBe(first);
    const child = spawn(process.execPath, ["-e", "0"], { windowsHide: true });
    await new Promise((done) => child.once("exit", done));
    expect(await defaultProcessIdentity(child.pid!)).toBeNull();
  }, 60_000);

  it("默认的结束进程树：对不可能存在的 PID 报 gone；沙箱里 taskkill 被拒时至少不能是「已结束」且进程确实不在", async () => {
    // 99_999_997 是奇数，Windows 的 PID 都是 4 的倍数；Linux 的 pid_max 也到不了。不会碰到真实进程。
    const result = await killProcessTree(99_999_997);
    if (result.kind === "gone") expect(result).toEqual({ kind: "gone" });
    else {
      // 受限环境（例如审查沙箱）里 taskkill 可能直接「拒绝访问」（退出码 1）：产品按失败处理是对的，
      // 这里只确认它没有谎报成已结束，而且那个 PID 确实不存在。
      expect(result.kind).toBe("failed");
      expect(isPidAlive(99_999_997)).toBe(false);
    }
    expect(await killProcessTree(0)).toEqual({ kind: "gone" });
  }, 60_000);
});

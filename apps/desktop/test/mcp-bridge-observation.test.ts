import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  assertPrivateBytesOnly,
  observeMcpBridgeCommands,
  observeMcpBridges,
} from "../src/mcp-bridge-observation.js";

const MIB = 1024 * 1024;

describe("MCP bridge 只读观测", () => {
  it("按稳定 bridge 路径列出父客户端、建立时间与累计 Private Bytes", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            pid: 4101,
            startedAt: "2026-08-27T02:00:00.000Z",
            privateBytes: 31 * MIB,
          },
          {
            pid: 4102,
            startedAt: "2026-08-27T02:01:00.000Z",
            privateBytes: 33 * MIB,
          },
        ]),
      })
      .mockResolvedValueOnce({
        stdout: [
          '"(PDH-CSV 4.0)","\\\\HOST\\Process(AyanamiTaskManager)\\ID Process","\\\\HOST\\Process(AyanamiTaskManager#1)\\ID Process","\\\\HOST\\Process(AyanamiTaskManager)\\Creating Process ID","\\\\HOST\\Process(AyanamiTaskManager#1)\\Creating Process ID"',
          '"08/27/2026 03:02:00.000","4101.000000","4102.000000","101.000000","202.000000"',
          "Exiting, please wait...",
        ].join("\r\n"),
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          { pid: 101, name: "codex" },
          { pid: 202, name: "claude" },
        ]),
      });

    const observation = await observeMcpBridges({
      bridgeCommand:
        "C:\\Users\\ayanami\\AppData\\Local\\AyanamiTaskManager\\current\\AyanamiTaskManager.exe",
      now: () => new Date("2026-08-27T03:02:03.000Z"),
      execute,
    });

    expect(observation).toEqual({
      sampledAt: "2026-08-27T03:02:03.000Z",
      metric: "PRIVATE_BYTES",
      totalPrivateBytes: 64 * MIB,
      bridges: [
        {
          pid: 4101,
          ownerPid: 101,
          ownerName: "codex",
          startedAt: "2026-08-27T02:00:00.000Z",
          privateBytes: 31 * MIB,
        },
        {
          pid: 4102,
          ownerPid: 202,
          ownerName: "claude",
          startedAt: "2026-08-27T02:01:00.000Z",
          privateBytes: 33 * MIB,
        },
      ],
    });
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls[0]?.[0]).toBe("powershell.exe");
    expect(execute.mock.calls[1]?.[0]).toBe("typeperf.exe");
  });

  it("没有 bridge 时不读取父进程计数器", async () => {
    const execute = vi.fn().mockResolvedValueOnce({ stdout: "[]" });

    await expect(
      observeMcpBridges({
        bridgeCommand: "C:\\ATM\\current\\AyanamiTaskManager.exe",
        now: () => new Date("2026-08-27T03:02:03.000Z"),
        execute,
      }),
    ).resolves.toEqual({
      sampledAt: "2026-08-27T03:02:03.000Z",
      metric: "PRIVATE_BYTES",
      totalPrivateBytes: 0,
      bridges: [],
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("只汇总 direct parent 为受支持 Agent 的进程，排除桌面同路径进程与退出竞态", async () => {
    const candidates = [
      { pid: 4101, privateBytes: 31 * MIB },
      { pid: 4102, privateBytes: 32 * MIB },
      { pid: 4103, privateBytes: 33 * MIB },
      { pid: 4104, privateBytes: 90 * MIB },
      { pid: 4105, privateBytes: 120 * MIB },
      { pid: 4106, privateBytes: 34 * MIB },
    ].map((entry, index) => ({
      ...entry,
      startedAt: `2026-08-27T02:0${index}:00.000Z`,
    }));
    const instances = candidates.map((_, index) =>
      index === 0 ? "AyanamiTaskManager" : `AyanamiTaskManager#${index}`,
    );
    const headers = [
      '"(PDH-CSV 4.0)"',
      ...instances.map((name) => `"\\\\HOST\\Process(${name})\\ID Process"`),
      ...instances.map((name) => `"\\\\HOST\\Process(${name})\\Creating Process ID"`),
    ].join(",");
    const values = [
      '"08/27/2026 03:02:00.000"',
      ...candidates.map((entry) => `"${entry.pid}.000000"`),
      ...[101, 202, 303, 404, 505, 606].map((pid) => `"${pid}.000000"`),
    ].join(",");
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify(candidates) })
      .mockResolvedValueOnce({ stdout: `${headers}\r\n${values}\r\n` })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          { pid: 101, name: "codex" },
          { pid: 202, name: "claude" },
          { pid: 303, name: "Claude" },
          { pid: 404, name: "explorer" },
          { pid: 505, name: "AyanamiTaskManager" },
          // 606 已经退出：不得把没有活父进程的候选算作连接。
        ]),
      });

    const observation = await observeMcpBridges({
      bridgeCommand: "C:\\ATM\\current\\AyanamiTaskManager.exe",
      now: () => new Date("2026-08-27T03:02:03.000Z"),
      execute,
    });

    expect(observation.bridges.map((bridge) => bridge.pid)).toEqual([4101, 4102, 4103]);
    expect(observation.bridges.map((bridge) => bridge.ownerName)).toEqual([
      "codex",
      "claude",
      "Claude",
    ]);
    expect(observation.totalPrivateBytes).toBe(96 * MIB);
  });

  // 宿主入口的一条连接是三个进程：Agent 拉起的启动器、它等着的宿主、宿主拉起的 atm-core。
  // 桥唤醒桌面时新宿主挂在 core 下面——那是桌面，不是这条连接，不能算进来。
  it("宿主入口按启动器 → 宿主 → atm-core 汇总，唤醒的桌面不算", async () => {
    const MiB = MIB;
    const rows: Array<[string, number, number, number]> = [
      // [实例名, pid, 父 pid, Private Bytes]
      ["AyanamiTaskManager", 4101, 101, 1 * MiB], // 启动器：codex 的直接子进程
      ["AyanamiTaskManager#1", 4201, 4101, 6 * MiB], // 宿主 --mcp-stdio
      ["atm-core", 4301, 4201, 40 * MiB], // stdio 桥
      ["AyanamiTaskManager#2", 4401, 4301, 2 * MiB], // 被唤醒的桌面启动器
      ["AyanamiTaskManager#3", 4501, 4401, 9 * MiB], // 桌面宿主
      ["atm-core#1", 4601, 4501, 120 * MiB], // 桌面 core
    ];
    const header = [
      '"(PDH-CSV 4.0)"',
      ...rows.flatMap(([name]) => [
        `"\\\\HOST\\Process(${name})\\ID Process"`,
        `"\\\\HOST\\Process(${name})\\Creating Process ID"`,
        `"\\\\HOST\\Process(${name})\\Private Bytes"`,
      ]),
    ].join(",");
    const values = [
      '"10/01/2026 03:02:00.000"',
      ...rows.flatMap(([, pid, parent, bytes]) => [
        `"${pid}.000000"`,
        `"${parent}.000000"`,
        `"${bytes}.000000"`,
      ]),
    ].join(",");
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          { pid: 4101, startedAt: "2026-10-01T02:00:00.000Z", privateBytes: 1 * MiB },
        ]),
      })
      .mockResolvedValueOnce({ stdout: `${header}\r\n${values}\r\n` })
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ pid: 101, name: "codex" }]) });

    const observation = await observeMcpBridges({
      bridgeCommand: "C:\\ATM\\current\\AyanamiTaskManager.exe",
      now: () => new Date("2026-10-01T03:02:03.000Z"),
      execute,
    });

    expect(observation.bridges).toEqual([
      expect.objectContaining({ pid: 4101, ownerName: "codex", privateBytes: 47 * MiB }),
    ]);
    expect(observation.totalPrivateBytes).toBe(47 * MiB);
    // 同一次采样里要带上链上两种进程的 Private Bytes。
    const counters = (execute.mock.calls[1]?.[1] ?? []) as string[];
    expect(counters).toContain("\\Process(atm-core*)\\Creating Process ID");
    expect(counters).toContain("\\Process(atm-core*)\\Private Bytes");
    expect(counters).toContain("\\Process(AyanamiTaskManager*)\\Private Bytes");
  });

  // 便携版的回落直接指向宿主：Agent → 宿主 → atm-core，少了启动器那一层。
  it("根就是宿主时按宿主 → atm-core 汇总，唤醒的桌面不算", async () => {
    const MiB = MIB;
    const rows: Array<[string, number, number, number]> = [
      // [实例名, pid, 父 pid, Private Bytes]
      ["AyanamiTaskManager", 4101, 101, 6 * MiB], // 宿主 --mcp-stdio：codex 的直接子进程
      ["atm-core", 4301, 4101, 40 * MiB], // stdio 桥
      ["AyanamiTaskManager#2", 4401, 4301, 2 * MiB], // 被唤醒的桌面启动器
      ["AyanamiTaskManager#3", 4501, 4401, 9 * MiB], // 桌面宿主
      ["atm-core#1", 4601, 4501, 120 * MiB], // 桌面 core
    ];
    const header = [
      '"(PDH-CSV 4.0)"',
      ...rows.flatMap(([name]) => [
        `"\\\\HOST\\Process(${name})\\ID Process"`,
        `"\\\\HOST\\Process(${name})\\Creating Process ID"`,
        `"\\\\HOST\\Process(${name})\\Private Bytes"`,
      ]),
    ].join(",");
    const values = [
      '"10/01/2026 03:02:00.000"',
      ...rows.flatMap(([, pid, parent, bytes]) => [
        `"${pid}.000000"`,
        `"${parent}.000000"`,
        `"${bytes}.000000"`,
      ]),
    ].join(",");
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          { pid: 4101, startedAt: "2026-10-01T02:00:00.000Z", privateBytes: 6 * MiB },
        ]),
      })
      .mockResolvedValueOnce({ stdout: `${header}\r\n${values}\r\n` })
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ pid: 101, name: "codex" }]) });

    const observation = await observeMcpBridges({
      bridgeCommand: "C:\\ATM\\portable\\AyanamiTaskManager.exe",
      now: () => new Date("2026-10-01T03:02:03.000Z"),
      execute,
    });

    expect(observation.bridges).toEqual([
      expect.objectContaining({ pid: 4101, ownerName: "codex", privateBytes: 46 * MiB }),
    ]);
    expect(observation.totalPrivateBytes).toBe(46 * MiB);
    // 同一次采样里要带上链上两种进程的 Private Bytes。
    const counters = (execute.mock.calls[1]?.[1] ?? []) as string[];
    expect(counters).toContain("\\Process(atm-core*)\\Creating Process ID");
    expect(counters).toContain("\\Process(atm-core*)\\Private Bytes");
    expect(counters).toContain("\\Process(AyanamiTaskManager*)\\Private Bytes");
  });

  it("shim 没有下游进程，不取链上的计数器", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          { pid: 5101, startedAt: "2026-10-01T02:00:00.000Z", privateBytes: MIB },
        ]),
      })
      .mockResolvedValueOnce({
        stdout: [
          '"(PDH-CSV 4.0)","\\\\HOST\\Process(atm-mcp)\\ID Process","\\\\HOST\\Process(atm-mcp)\\Creating Process ID"',
          '"10/01/2026 03:02:00.000","5101.000000","202.000000"',
        ].join("\r\n"),
      })
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ pid: 202, name: "claude" }]) });
    const observation = await observeMcpBridges({
      bridgeCommand: "C:\\ATM\\current\\resources\\atm-mcp.exe",
      execute,
    });
    expect(observation.totalPrivateBytes).toBe(MIB);
    expect((execute.mock.calls[1]?.[1] as string[]).join(" ")).not.toContain("atm-core");
  });

  it("静态守卫拒绝 Working Set 总和并保留阳性验红对照", () => {
    expect(() => assertPrivateBytesOnly("const bytes = process.PrivateMemorySize64")).not.toThrow();
    expect(() => assertPrivateBytesOnly("const total = process.WorkingSet64")).toThrow(
      /PRIVATE_BYTES_ONLY/u,
    );

    const source = readFileSync(
      join(process.cwd(), "apps", "desktop", "src", "mcp-bridge-observation.ts"),
      "utf8",
    );
    expect(() => assertPrivateBytesOnly(source)).not.toThrow();
    expect(source).not.toMatch(/Get-(?:CimInstance|WmiObject)/u);
  });

  // 切到原生 shim 之后，已开着的会话仍握着宿主入口的旧配置直到重启。两种都要数，
  // 只数新的会把省下来的量算多。两次观测是并发的，所以按参数分派而不是按调用顺序。
  it("同时统计 shim 与旧 Electron 桥，同一路径只查一次", async () => {
    const shim = "C:\\ATM\\current\\resources\\atm-mcp.exe";
    const electron = "C:\\ATM\\current\\AyanamiTaskManager.exe";
    const csv = (instance: string, pid: number, parent: number) =>
      [
        `"(PDH-CSV 4.0)","\\\\HOST\\Process(${instance})\\ID Process","\\\\HOST\\Process(${instance})\\Creating Process ID"`,
        `"08/27/2026 03:02:00.000","${pid}.000000","${parent}.000000"`,
      ].join("\r\n");
    const execute = vi.fn(async (file: string, args: string[]) => {
      const text = args.join(" ");
      if (file === "powershell.exe" && text.includes("Get-Process -Name 'atm-mcp'"))
        return {
          stdout: JSON.stringify([
            { pid: 5101, startedAt: "2026-08-27T02:00:00.000Z", privateBytes: 1 * MIB },
          ]),
        };
      if (file === "powershell.exe" && text.includes("Get-Process -Name 'AyanamiTaskManager'"))
        return {
          stdout: JSON.stringify([
            { pid: 4101, startedAt: "2026-08-27T01:00:00.000Z", privateBytes: 30 * MIB },
          ]),
        };
      if (file === "typeperf.exe" && text.includes("Process(atm-mcp*)"))
        return { stdout: csv("atm-mcp", 5101, 202) };
      if (file === "typeperf.exe" && text.includes("Process(AyanamiTaskManager*)"))
        return { stdout: csv("AyanamiTaskManager", 4101, 101) };
      if (file === "powershell.exe" && text.includes("$ids"))
        return {
          stdout: JSON.stringify([
            { pid: 101, name: "codex" },
            { pid: 202, name: "claude" },
          ]),
        };
      throw new Error(`unexpected call: ${file} ${text.slice(0, 80)}`);
    });

    const observation = await observeMcpBridgeCommands({
      bridgeCommands: [shim, electron, shim.toUpperCase()],
      now: () => new Date("2026-08-27T03:02:03.000Z"),
      execute,
    });

    expect(observation.bridges.map(({ pid, ownerName }) => ({ pid, ownerName }))).toEqual([
      { pid: 5101, ownerName: "claude" },
      { pid: 4101, ownerName: "codex" },
    ]);
    expect(observation.totalPrivateBytes).toBe(31 * MIB);
    // 两条不同路径各三次调用；大小写不同的重复路径不再查询。
    expect(execute).toHaveBeenCalledTimes(6);
  });
});

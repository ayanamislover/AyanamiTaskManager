import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { assertPrivateBytesOnly, observeMcpBridges } from "../src/mcp-bridge-observation.js";

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
});

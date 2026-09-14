import { describe, expect, it } from "vitest";
import { prefetchSelfProcessIdentity, readProcessIdentity } from "../src/process-identity.js";

// 单开一个文件，因为自身身份是模块级缓存：process-identity.test.ts 里那条真实查询
// 会把缓存填上，同一个文件里再测预取就只是在读别人填好的值。

describe("自身进程身份的预取", () => {
  it.runIf(process.platform === "win32")(
    "预取完成后同步读取直接命中缓存，不再付 spawnSync 的代价",
    async () => {
      await prefetchSelfProcessIdentity();

      const startedAt = process.hrtime.bigint();
      const identity = readProcessIdentity(process.pid);
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

      expect(identity?.createdAtTicks).toMatch(/^\d{17,19}$/u);
      expect(identity!.startedAtMs).toBeLessThanOrEqual(Date.now());
      // 实测这条路径不预取时是 166–266ms；命中缓存是亚毫秒。25ms 离两边都很远，
      // 既不会被机器抖动打红，也不可能在真的 spawn 了的情况下通过。
      expect(elapsedMs).toBeLessThan(25);
    },
  );

  it("重复调用共用同一次查询，且在非 Windows 上安静返回", async () => {
    const first = prefetchSelfProcessIdentity();
    expect(prefetchSelfProcessIdentity()).toBe(first);
    await expect(first).resolves.toBeUndefined();
  });
});

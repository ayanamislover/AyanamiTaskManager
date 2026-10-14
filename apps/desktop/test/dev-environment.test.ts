import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { devEnvironment } from "../scripts/dev.js";

const ROOT = resolve("/repo");

describe("pnpm dev 的数据根（W8i）", () => {
  it("两个数据根默认都在 output/ 下：只隔离 2.x 源根时，3.0 数据根会落到真实的 LOCALAPPDATA", () => {
    const env = devEnvironment(ROOT, { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" });
    expect(env.ATM_DATA_DIR).toBe(resolve(ROOT, "output/dev-data"));
    expect(env.ATM3_DATA_DIR).toBe(resolve(ROOT, "output/dev-data3"));
    expect(env.ATM_DEV_REPOSITORY_ROOT).toBe(ROOT);
    expect(env.LOCALAPPDATA).toBe("C:\\Users\\u\\AppData\\Local");
  });

  it("显式给的数据根照用；空值当作没给（与宿主解析一致）", () => {
    const given = devEnvironment(ROOT, { ATM_DATA_DIR: "D:\\l", ATM3_DATA_DIR: "D:\\n" });
    expect([given.ATM_DATA_DIR, given.ATM3_DATA_DIR]).toEqual(["D:\\l", "D:\\n"]);
    const blank = devEnvironment(ROOT, { ATM_DATA_DIR: "", ATM3_DATA_DIR: "" });
    expect(blank.ATM3_DATA_DIR).toBe(resolve(ROOT, "output/dev-data3"));
    expect(blank.ATM_DATA_DIR).toBe(resolve(ROOT, "output/dev-data"));
  });
});

import { describe, expect, it } from "vitest";
import { allocateProjectCode } from "../src/index.js";

describe("项目代码", () => {
  it("从名称生成稳定大写代码并在冲突时追加数字", () => {
    expect(allocateProjectCode("AyanamiAgent-Hub", new Set())).toBe("AHUB");
    expect(allocateProjectCode("AyanamiAgent-Hub", new Set(["AHUB", "AHUB2"]))).toBe("AHUB3");
    expect(allocateProjectCode("绫波任务管理器", new Set(), 12)).toBe("AYT-0012");
  });
});

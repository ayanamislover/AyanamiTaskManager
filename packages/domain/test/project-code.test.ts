import { AtmError } from "@ayanami-task/errors";
import { describe, expect, it } from "vitest";
import { allocateProjectCode, assertProjectCode } from "../src/index.js";

function captureAtmError(action: () => unknown): AtmError {
  try {
    action();
  } catch (error) {
    if (error instanceof AtmError) return error;
    throw error;
  }
  throw new Error("Expected action to throw AtmError");
}

describe("项目代码", () => {
  it("从名称生成稳定大写代码并在冲突时追加数字", () => {
    expect(allocateProjectCode("AyanamiAgent-Hub", new Set())).toBe("AHUB");
    expect(allocateProjectCode("AyanamiAgent-Hub", new Set(["AHUB", "AHUB2"]))).toBe("AHUB3");
    expect(allocateProjectCode("绫波任务管理器", new Set(), 12)).toBe("AYT-0012");
  });

  it("以 typed details 报告非法代码和候选耗尽", () => {
    expect(captureAtmError(() => assertProjectCode("bad-code"))).toMatchObject({
      code: "INVALID_PROJECT_CODE",
      details: { code: "bad-code", pattern: expect.any(String) },
    });

    const exhausted = new Set(["AHUB"]);
    for (let suffix = 2; suffix < 10_000; suffix += 1) exhausted.add(`AHUB${suffix}`);
    expect(captureAtmError(() => allocateProjectCode("AyanamiAgent-Hub", exhausted))).toMatchObject(
      {
        code: "PROJECT_CODE_EXHAUSTED",
        details: { name: "AyanamiAgent-Hub", base: "AHUB", attempts: 9_999 },
      },
    );
  });
});

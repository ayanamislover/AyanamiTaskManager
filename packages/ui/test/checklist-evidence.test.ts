import { describe, expect, it } from "vitest";
import { checklistToggleIntent, evidenceText } from "../src/checklist-evidence.js";

describe("检查项证据", () => {
  it("必证且无证据时勾选先索要证据，而不是提交必然被拒的请求", () => {
    expect(checklistToggleIntent({ status: "TODO", evidenceRequired: true, evidence: [] })).toEqual(
      {
        action: "request-evidence",
      },
    );
    expect(
      checklistToggleIntent({ status: "TODO", evidenceRequired: true, evidence: ["已有证据"] }),
    ).toEqual({ action: "patch", status: "DONE" });
    expect(checklistToggleIntent({ status: "TODO", evidenceRequired: false })).toEqual({
      action: "patch",
      status: "DONE",
    });
    // 取消勾选不该索要证据，否则已完成项会被卡住无法回退。
    expect(checklistToggleIntent({ status: "DONE", evidenceRequired: true, evidence: [] })).toEqual(
      {
        action: "patch",
        status: "TODO",
      },
    );
  });

  it("容忍历史上所有证据形状，任何条目都不因形状不符而丢失", () => {
    // 库里实际存在的形状：纯字符串占多数，其余是上百种一次性对象。
    expect(evidenceText("packaged smoke 11/11")).toBe("packaged smoke 11/11");
    expect(evidenceText({ kind: "test", summary: "51 tests 全绿" })).toBe("test: 51 tests 全绿");
    expect(evidenceText({ kind: "commit", ref: "ab06501" })).toBe("commit: ab06501");
    expect(evidenceText({ note: "手工核对", path: "R:/x" })).toBe("手工核对");
    expect(evidenceText({ command: "pnpm test", result: "pass" })).toBe("pass");
    // 没有任何已知说明字段时压成 JSON，而不是渲染成 [object Object]。
    expect(evidenceText({ passed: true, count: 3 })).toBe('{"passed":true,"count":3}');
    expect(evidenceText(["a", "b"])).toBe('["a","b"]');
    expect(evidenceText(null)).toBe("null");
    expect(evidenceText(42)).toBe("42");
    // 空白字段不算说明，应继续向后找。
    expect(evidenceText({ summary: "   ", ref: "r-1" })).toBe("r-1");
  });
});

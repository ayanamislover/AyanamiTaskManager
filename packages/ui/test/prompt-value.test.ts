import { describe, expect, it } from "vitest";
import { promptValue } from "../src/components/atm-dialogs.js";

describe("输入框交出的值", () => {
  it("默认去掉首尾空白，全是空白算没填", () => {
    expect(promptValue("  旧项目  ")).toBe("旧项目");
    expect(promptValue("   ")).toBeNull();
    expect(promptValue("")).toBeNull();
  });

  it("确认词原样交给服务端：首尾空白和大小写都不替用户改", () => {
    expect(promptValue(" OLD ", true)).toBe(" OLD ");
    expect(promptValue("old", true)).toBe("old");
    expect(promptValue("   ", true)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  formatReconciliationAge,
  reconciliationLabel,
  reconciliationSummary,
} from "../src/reconciliation.js";

describe("项目对账展示", () => {
  it("默认摘要只强调需对账数量", () => {
    expect(reconciliationSummary(undefined)).toBe("正在检查需对账项…");
    expect(reconciliationSummary({ attentionCount: 0 })).toBe("无需对账");
    expect(reconciliationSummary({ attentionCount: 3 })).toBe("需对账 3 项");
  });

  it("分类与年龄使用面向用户的短文案", () => {
    expect(reconciliationLabel("LEASE_EXPIRED_ONLINE")).toBe("在线但领取过期");
    expect(reconciliationLabel("STALLED")).toBe("任务停滞");
    expect(reconciliationLabel("POSSIBLY_COMPLETE")).toBe("可能已完成");
    expect(formatReconciliationAge(59)).toBe("刚刚");
    expect(formatReconciliationAge(3600)).toBe("1 小时");
    expect(formatReconciliationAge(172800)).toBe("2 天");
  });
});

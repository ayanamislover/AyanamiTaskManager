import { describe, expect, it } from "vitest";
import { ATM_QUERY_REFRESH_INTERVAL_MS, createAyanamiQueryClient } from "../src/query-policy.js";

describe("ATM 客户端刷新策略", () => {
  it("所有活跃查询默认每 30 秒刷新一次", () => {
    const client = createAyanamiQueryClient();

    expect(ATM_QUERY_REFRESH_INTERVAL_MS).toBe(30_000);
    expect(client.getDefaultOptions().queries?.refetchInterval).toBe(30_000);
  });
});

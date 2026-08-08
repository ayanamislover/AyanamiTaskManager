import { describe, expect, it } from "vitest";
import { WorkItemCreateInputSchema } from "../src/index.js";

const base = {
  clientRef: "follow-up",
  objectiveId: "01KZHP4PGMNK7BG8440ZYG5AJP",
  title: "跟进审计异常",
};

describe("DISCOVERED_FROM 创建协议", () => {
  it("接受已存在任务键或同批 client_ref，但拒绝同时指定", () => {
    expect(
      WorkItemCreateInputSchema.parse({ ...base, discoveredFrom: "ATM-T-0044" }),
    ).toMatchObject({ discoveredFrom: "ATM-T-0044" });
    expect(WorkItemCreateInputSchema.parse({ ...base, discoveredFromRef: "origin" })).toMatchObject(
      { discoveredFromRef: "origin" },
    );
    expect(() =>
      WorkItemCreateInputSchema.parse({
        ...base,
        discoveredFrom: "ATM-T-0044",
        discoveredFromRef: "origin",
      }),
    ).toThrow();
  });
});

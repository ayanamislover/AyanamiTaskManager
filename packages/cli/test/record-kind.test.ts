import { describe, expect, it } from "vitest";
import type { AyanamiClient } from "@ayanami-task/client";
import { createCliProgram } from "../src/index.js";

function fakeClient() {
  const begun: string[] = [];
  const recorded: Array<Record<string, unknown>> = [];
  const client = {
    sessions: {
      begin: async () => {
        begun.push("begin");
        return { session: "session-1" };
      },
      end: async () => ({ ok: true }),
    },
    record: async (_project: string, input: Record<string, unknown>) => {
      recorded.push(input);
      return { ok: true };
    },
  } as unknown as AyanamiClient;
  return { client, begun, recorded };
}

describe("CLI record kind", () => {
  it("接受大小写无关的公开枚举，非法值在创建 Session 前失败", async () => {
    const valid = fakeClient();
    await createCliProgram({ client: valid.client, write: () => undefined }).parseAsync([
      "node",
      "atm",
      "record",
      "ATM",
      "--kind",
      "fact",
      "--summary",
      "validated",
    ]);
    expect(valid.recorded[0]?.kind).toBe("FACT");

    const invalid = fakeClient();
    await expect(
      createCliProgram({ client: invalid.client, write: () => undefined }).parseAsync([
        "node",
        "atm",
        "record",
        "ATM",
        "--kind",
        "not-a-kind",
        "--summary",
        "invalid",
      ]),
    ).rejects.toThrow();
    expect(invalid.begun).toEqual([]);
    expect(invalid.recorded).toEqual([]);
  });
});

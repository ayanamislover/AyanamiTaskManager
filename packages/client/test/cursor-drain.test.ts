import { describe, expect, it } from "vitest";
import { AyanamiClientError, drainCursorPages, type CursorPage } from "../src/index.js";

const page = (
  items: number[],
  nextCursor: string | null,
  hasMore: boolean,
): CursorPage<number> => ({
  items,
  nextCursor,
  hasMore,
});

describe("bounded cursor drain", () => {
  it("drains every page and validates the cursor chain", async () => {
    const calls: Array<string | undefined> = [];
    await expect(
      drainCursorPages(
        async (cursor) => {
          calls.push(cursor);
          return cursor === undefined ? page([1, 2], "next", true) : page([3], null, false);
        },
        { entity: "TASK_PAGE" },
      ),
    ).resolves.toEqual([1, 2, 3]);
    expect(calls).toEqual([undefined, "next"]);
  });

  it("fails closed with a resumable cursor when a safety limit is reached", async () => {
    await expect(
      drainCursorPages(
        async (cursor) => (cursor ? page([2], "third", true) : page([1], "second", true)),
        { entity: "TASK_PAGE", maxPages: 1 },
      ),
    ).rejects.toMatchObject<AyanamiClientError>({
      code: "INVALID_RESPONSE",
      status: 502,
      details: {
        entity: "TASK_PAGE",
        reason: "DRAIN_LIMIT_REACHED",
        resumeCursor: "second",
      },
    });

    await expect(
      drainCursorPages(
        async (cursor) => (cursor ? page([2], null, false) : page([1, 2], "second", true)),
        { entity: "TASK_PAGE", maxItems: 1 },
      ),
    ).rejects.toMatchObject<AyanamiClientError>({
      details: { reason: "DRAIN_LIMIT_REACHED", resumeCursor: null },
    });
  });

  it("rejects missing and repeated cursors without looping", async () => {
    await expect(
      drainCursorPages(async () => page([1], null, true), { entity: "RECORD_PAGE" }),
    ).rejects.toMatchObject<AyanamiClientError>({
      details: { reason: "MISSING_NEXT_CURSOR" },
    });

    let calls = 0;
    await expect(
      drainCursorPages(
        async () => {
          calls += 1;
          return page([1], "same", true);
        },
        { entity: "SESSION_PAGE" },
      ),
    ).rejects.toMatchObject<AyanamiClientError>({
      details: { reason: "REPEATED_CURSOR" },
    });
    expect(calls).toBe(2);
  });
});

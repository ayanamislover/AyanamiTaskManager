import { AtmError } from "@ayanami-task/errors";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { externalizeObjectSchema } from "../src/index.js";

function captureAtmError(action: () => unknown): AtmError {
  try {
    action();
  } catch (error) {
    if (error instanceof AtmError) return error;
    throw error;
  }
  throw new Error("Expected action to throw AtmError");
}

describe("protocol typed errors", () => {
  it("reports a missing external field name without a message protocol", () => {
    const canonical = z.object({ canonicalField: z.string() });
    expect(
      captureAtmError(() => externalizeObjectSchema(canonical, {} as { canonicalField: string })),
    ).toMatchObject({
      code: "EXTERNAL_NAME_MISSING",
      details: { canonical_key: "canonicalField" },
    });
  });
});

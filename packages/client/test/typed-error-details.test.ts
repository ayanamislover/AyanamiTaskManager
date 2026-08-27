import { describe, expect, it } from "vitest";
import { AyanamiClient, AyanamiClientError } from "../src/index.js";

describe("AyanamiClient typed error details", () => {
  it("keeps details and retryability from the REST envelope", async () => {
    const details = { entity: "WORK_ITEM", key: "ATM-T-9999", expected: 2, actual: 4 };
    const client = new AyanamiClient({
      endpoint: "http://127.0.0.1:9999",
      token: "token",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "VERSION_CONFLICT",
              message: "任务版本已变化",
              details,
              retryable: true,
            },
            request_id: "request-1",
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
    });

    const failure = await client.projects.get("ATM").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AyanamiClientError);
    expect(failure).toMatchObject({
      code: "VERSION_CONFLICT",
      status: 409,
      requestId: "request-1",
      details,
      retryable: true,
    });
  });
});

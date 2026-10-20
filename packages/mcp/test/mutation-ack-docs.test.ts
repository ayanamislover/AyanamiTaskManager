import { describe, expect, it } from "vitest";
import { MUTATION_ACK_CONTRACT } from "../src/mutation-ack-contract.js";

describe("generated mutation acknowledgement documentation", () => {
  it("defines the exact bounded receipt and executable durable lookup", () => {
    expect(MUTATION_ACK_CONTRACT.fields).toEqual([
      "ok",
      "op_id",
      "project",
      "session",
      "session_rebound",
      "projection",
      "entities",
      "entity_count",
      "entities_truncated",
      "details_cursor",
    ]);
    expect(MUTATION_ACK_CONTRACT.entityPreview).toEqual({ maxItems: 12, maxChars: 1800 });
    expect(MUTATION_ACK_CONTRACT.detailsCursor).toEqual({
      name: "atm_search",
      fieldMask: ["op_id", "entities"],
      maxChars: 50_000,
    });
    expect(MUTATION_ACK_CONTRACT.operationDetailsFieldMask).toEqual(["op_id", "mutations"]);
  });
});

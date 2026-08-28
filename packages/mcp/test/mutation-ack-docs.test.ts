import { readFileSync } from "node:fs";
import { format } from "prettier";
import { describe, expect, it } from "vitest";
import {
  generateMutationAcknowledgementDocumentation,
  MUTATION_ACK_CONTRACT,
  MUTATION_ACK_DOCUMENTATION_BEGIN,
  MUTATION_ACK_DOCUMENTATION_END,
} from "../src/mutation-ack-contract.js";

function markedSection(content: string): string {
  const start = content.indexOf(MUTATION_ACK_DOCUMENTATION_BEGIN);
  const end = content.indexOf(MUTATION_ACK_DOCUMENTATION_END);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return content.slice(start, end + MUTATION_ACK_DOCUMENTATION_END.length);
}

describe("generated mutation acknowledgement documentation", () => {
  it("keeps source and packaged Agent documents synchronized with the runtime contract", async () => {
    const expected = (
      await format(generateMutationAcknowledgementDocumentation(), { parser: "markdown" })
    ).trim();
    for (const path of [
      "ATM_AGENT_GUIDE.md",
      "docs/agent-integration.md",
      "docs/generated/mutation-acknowledgement.md",
    ]) {
      expect(markedSection(readFileSync(path, "utf8"))).toBe(expected);
    }
  });

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

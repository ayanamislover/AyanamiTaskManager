import { describe, expect, it } from "vitest";
import { stableIdleRssMegabytes } from "../../../scripts/benchmark-memory-policy.js";

describe("benchmark idle RSS sampling", () => {
  it("discards startup warm-up samples and uses the median retained footprint", () => {
    expect(stableIdleRssMegabytes([220, 180, 145, 147, 146])).toBe(146);
  });

  it("rejects too few or invalid samples", () => {
    expect(() => stableIdleRssMegabytes([145, 146, 147, 148])).toThrow(
      "BENCHMARK_RSS_SAMPLES_INVALID",
    );
    expect(() => stableIdleRssMegabytes([145, 146, Number.NaN, 148, 149])).toThrow(
      "BENCHMARK_RSS_SAMPLES_INVALID",
    );
  });
});

export function stableIdleRssMegabytes(samples: readonly number[]): number {
  if (samples.length < 5 || samples.some((sample) => !Number.isFinite(sample) || sample <= 0)) {
    throw new Error("BENCHMARK_RSS_SAMPLES_INVALID");
  }
  const stableSamples = samples.slice(2).sort((left, right) => left - right);
  return stableSamples[Math.floor(stableSamples.length / 2)]!;
}

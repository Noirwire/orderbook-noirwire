export function median(sorted: number[]): number {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The smallest sample that at least `percent` of the samples do not exceed. */
export function percentile(sorted: number[], percent: number): number {
  return sorted[Math.ceil((sorted.length * percent) / 100) - 1];
}

/** "median 12 ms, p95 30 ms, worst 41 ms". */
export function spread(samplesMs: number[]): string {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const worst = sorted[sorted.length - 1];
  return `median ${median(sorted).toFixed(0)} ms, p95 ${percentile(sorted, 95).toFixed(0)} ms, worst ${worst.toFixed(0)} ms`;
}

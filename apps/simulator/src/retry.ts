export function retryDelayMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 30));
  return Math.max(1, Math.floor(ceiling * (0.5 + random() * 0.5)));
}

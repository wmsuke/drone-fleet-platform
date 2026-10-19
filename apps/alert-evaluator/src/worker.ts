import type { EvaluationCounts } from "./repository.js";
export interface AlertRepository {
  deviceIds(): Promise<string[]>;
  commandIds(now: Date): Promise<string[]>;
  evaluateDevice(id: string, now: Date): Promise<EvaluationCounts>;
  evaluateCommand(id: string, now: Date): Promise<EvaluationCounts>;
}
export function createAlertWorker(
  repository: AlertRepository,
  intervalMs: number,
  report: (
    metrics: EvaluationCounts & {
      evaluated: number;
      failed: number;
      durationMs: number;
      evaluationLagMs: number;
    },
  ) => void,
  clock = () => new Date(),
) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  let expected = clock().getTime();
  async function evaluate() {
    const now = clock(),
      start = performance.now();
    const metrics = {
      evaluated: 0,
      created: 0,
      updated: 0,
      resolved: 0,
      failed: 0,
      durationMs: 0,
      evaluationLagMs: Math.max(0, now.getTime() - expected),
    };
    for (const [read, action] of [
      [repository.deviceIds, repository.evaluateDevice],
      [() => repository.commandIds(now), repository.evaluateCommand],
    ] as const) {
      try {
        const ids = await read();
        for (const id of ids) {
          if (stopped) break;
          try {
            const result = await action(id, now);
            metrics.evaluated++;
            metrics.created += result.created;
            metrics.updated += result.updated;
            metrics.resolved += result.resolved;
          } catch {
            metrics.failed++;
          }
        }
      } catch {
        metrics.failed++;
      }
    }
    metrics.durationMs = performance.now() - start;
    try {
      report(metrics);
    } catch {
      /* 計測の失敗でcommit済みの結果を失敗扱いにしない */
    }
  }
  function runOnce() {
    active ??= evaluate().finally(() => {
      active = undefined;
    });
    return active;
  }
  async function tick() {
    await runOnce();
    if (!stopped) {
      expected = clock().getTime() + intervalMs;
      timer = setTimeout(() => void tick(), intervalMs);
    }
  }
  return {
    runOnce,
    start() {
      if (!timer && !active && !stopped) void tick();
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await active;
    },
  };
}

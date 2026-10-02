import { performance } from "node:perf_hooks";

import { writeJsonReport } from "./io.js";

export interface ApiProbeReport {
  schemaVersion: 1;
  testId: string;
  startedAt: string;
  endedAt: string;
  targetUrl: string;
  counters: {
    attempted: number;
    succeeded: number;
    failed: number;
    timedOut: number;
  };
  errorRate: number;
  timings: {
    minMs: number | null;
    maxMs: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
    p99Ms: number | null;
  };
}

interface ProbeOptions {
  testId: string;
  targetUrl: string;
  durationMs: number;
  intervalMs: number;
  timeoutMs: number;
}

function percentile(sorted: number[], ratio: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.ceil(sorted.length * ratio) - 1] ?? null;
}

export async function runApiProbe(
  options: ProbeOptions,
  dependencies: {
    fetch?: typeof fetch;
    now?: () => Date;
    monotonicNow?: () => number;
    wait?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<ApiProbeReport> {
  const request = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? (() => new Date());
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  const wait =
    dependencies.wait ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const startedAt = now();
  const deadline = monotonicNow() + options.durationMs;
  const timings: number[] = [];
  const counters = { attempted: 0, succeeded: 0, failed: 0, timedOut: 0 };

  while (monotonicNow() < deadline) {
    const requestStartedAt = monotonicNow();
    counters.attempted += 1;
    try {
      const response = await request(options.targetUrl, {
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      const elapsed = monotonicNow() - requestStartedAt;
      if (response.ok) {
        counters.succeeded += 1;
        timings.push(elapsed);
      } else {
        counters.failed += 1;
      }
    } catch (error) {
      counters.failed += 1;
      if (error instanceof Error && error.name === "TimeoutError") {
        counters.timedOut += 1;
      }
    }
    const remaining = options.intervalMs - (monotonicNow() - requestStartedAt);
    if (remaining > 0) await wait(remaining);
  }

  timings.sort((left, right) => left - right);
  return {
    schemaVersion: 1,
    testId: options.testId,
    startedAt: startedAt.toISOString(),
    endedAt: now().toISOString(),
    targetUrl: options.targetUrl,
    counters,
    errorRate:
      counters.attempted === 0 ? 0 : counters.failed / counters.attempted,
    timings: {
      minMs: timings[0] ?? null,
      maxMs: timings.at(-1) ?? null,
      p50Ms: percentile(timings, 0.5),
      p95Ms: percentile(timings, 0.95),
      p99Ms: percentile(timings, 0.99),
    },
  };
}

function positiveInteger(name: string): number {
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

async function main(): Promise<void> {
  const testId = process.env.LOAD_TEST_ID;
  const targetUrl = process.env.LOAD_API_URL;
  const outputPath = process.env.LOAD_API_REPORT_PATH;
  if (
    testId === undefined ||
    targetUrl === undefined ||
    outputPath === undefined
  ) {
    throw new TypeError(
      "LOAD_TEST_ID, LOAD_API_URL and LOAD_API_REPORT_PATH are required",
    );
  }
  const report = await runApiProbe({
    testId,
    targetUrl,
    durationMs: positiveInteger("LOAD_API_DURATION_MS"),
    intervalMs: positiveInteger("LOAD_API_INTERVAL_MS"),
    timeoutMs: positiveInteger("LOAD_API_TIMEOUT_MS"),
  });
  await writeJsonReport(outputPath, report);
  console.log(
    `API計測: success=${report.counters.succeeded} failed=${report.counters.failed} p95=${report.timings.p95Ms ?? "n/a"}ms`,
  );
}

if (process.argv[1]?.endsWith("api-probe.js")) {
  main().catch((error: unknown) => {
    console.error("API計測に失敗しました", error);
    process.exitCode = 1;
  });
}

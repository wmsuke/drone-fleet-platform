import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { LoadMetricsConfig } from "./config.js";

export const LATENCY_BUCKET_BOUNDARIES_MS = [
  -60_000, -10_000, -5_000, -2_000, -1_000, -500, -200, -100, -50, -20, -10, -5,
  -2, -1, 0, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000,
  30_000, 60_000,
] as const;

export interface HistogramSnapshot {
  count: number;
  sumMs: number;
  minMs: number | null;
  maxMs: number | null;
  buckets: Array<{ leMs: number | null; count: number }>;
}

export interface LoadMetricsReport {
  schemaVersion: 1;
  testId: string;
  sessionId: string;
  startedAt: string;
  endedAt: string;
  counters: {
    mqttReceived: number;
    validationSucceeded: number;
    validationFailed: number;
    dbSaveSucceeded: number;
    dbSaveFailed: number;
    dbInserted: number;
    telemetryDuplicates: number;
    telemetryConflicts: number;
    offlineTransitions: number;
  };
  timings: {
    deviceTimestampToMqttReceiveMs: HistogramSnapshot;
    mqttReceiveToDbCompleteMs: HistogramSnapshot;
  };
}

class Histogram {
  private count = 0;
  private sumMs = 0;
  private minMs: number | null = null;
  private maxMs: number | null = null;
  private readonly buckets = Array.from(
    { length: LATENCY_BUCKET_BOUNDARIES_MS.length + 1 },
    () => 0,
  );

  record(valueMs: number): void {
    if (!Number.isFinite(valueMs)) return;
    this.count += 1;
    this.sumMs += valueMs;
    this.minMs = this.minMs === null ? valueMs : Math.min(this.minMs, valueMs);
    this.maxMs = this.maxMs === null ? valueMs : Math.max(this.maxMs, valueMs);
    const index = LATENCY_BUCKET_BOUNDARIES_MS.findIndex(
      (boundary) => valueMs <= boundary,
    );
    const bucketIndex = index === -1 ? this.buckets.length - 1 : index;
    this.buckets[bucketIndex] = (this.buckets[bucketIndex] ?? 0) + 1;
  }

  snapshot(): HistogramSnapshot {
    return {
      count: this.count,
      sumMs: this.sumMs,
      minMs: this.minMs,
      maxMs: this.maxMs,
      buckets: this.buckets.map((count, index) => ({
        leMs: LATENCY_BUCKET_BOUNDARIES_MS[index] ?? null,
        count,
      })),
    };
  }
}

export interface LoadMetrics {
  recordMqttReceived(measuredAt?: Date): boolean;
  recordValidationSuccess(deviceTimestamp: string, receivedAt: Date): void;
  recordValidationFailure(): void;
  recordDbSaveSuccess(durationMs: number): void;
  recordDbSaveFailure(durationMs: number): void;
  recordTelemetryOutcome(outcome: "saved" | "duplicate" | "conflict"): void;
  recordOfflineTransitions(count: number, updatedAt?: Date): void;
  writeReport(endedAt?: Date): Promise<LoadMetricsReport>;
  snapshot(endedAt?: Date): LoadMetricsReport;
}

export interface LoadMetricsDependencies {
  now?: () => Date;
  writeFile?: (path: string, report: LoadMetricsReport) => Promise<void>;
}

async function writeJsonReport(
  path: string,
  report: LoadMetricsReport,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  await rename(temporaryPath, path);
}

export function createLoadMetrics(
  config: LoadMetricsConfig,
  dependencies: LoadMetricsDependencies = {},
): LoadMetrics {
  const now = dependencies.now ?? (() => new Date());
  const reportWriter = dependencies.writeFile ?? writeJsonReport;
  const startedAt = config.measurementStartAt ?? now();
  const counters = {
    mqttReceived: 0,
    validationSucceeded: 0,
    validationFailed: 0,
    dbSaveSucceeded: 0,
    dbSaveFailed: 0,
    dbInserted: 0,
    telemetryDuplicates: 0,
    telemetryConflicts: 0,
    offlineTransitions: 0,
  };
  const receiveLatency = new Histogram();
  const saveDuration = new Histogram();
  const isMeasured = (at: Date): boolean =>
    (config.measurementStartAt === undefined ||
      at >= config.measurementStartAt) &&
    (config.measurementEndAt === undefined || at < config.measurementEndAt);

  const snapshot = (
    endedAt = config.measurementEndAt ?? now(),
  ): LoadMetricsReport => ({
    schemaVersion: 1,
    testId: config.testId,
    sessionId: config.sessionId,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    counters: { ...counters },
    timings: {
      deviceTimestampToMqttReceiveMs: receiveLatency.snapshot(),
      mqttReceiveToDbCompleteMs: saveDuration.snapshot(),
    },
  });

  return {
    recordMqttReceived(measuredAt = now()) {
      if (!isMeasured(measuredAt)) return false;
      counters.mqttReceived += 1;
      return true;
    },
    recordValidationSuccess(deviceTimestamp, receivedAt) {
      counters.validationSucceeded += 1;
      receiveLatency.record(
        receivedAt.getTime() - new Date(deviceTimestamp).getTime(),
      );
    },
    recordValidationFailure() {
      counters.validationFailed += 1;
    },
    recordDbSaveSuccess(durationMs) {
      counters.dbSaveSucceeded += 1;
      saveDuration.record(durationMs);
    },
    recordDbSaveFailure(durationMs) {
      counters.dbSaveFailed += 1;
      saveDuration.record(durationMs);
    },
    recordTelemetryOutcome(outcome) {
      if (outcome === "saved") counters.dbInserted += 1;
      else if (outcome === "duplicate") counters.telemetryDuplicates += 1;
      else counters.telemetryConflicts += 1;
    },
    recordOfflineTransitions(count, updatedAt = now()) {
      if (!isMeasured(updatedAt)) return;
      counters.offlineTransitions += count;
    },
    snapshot,
    async writeReport(endedAt = config.measurementEndAt ?? now()) {
      const report = snapshot(endedAt);
      await reportWriter(config.reportPath, report);
      return report;
    },
  };
}

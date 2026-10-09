import type {
  AggregatedHistogram,
  GeneratorReport,
  HistogramReport,
  IngestorReport,
  LoadReportRepository,
  LoadTestReport,
} from "./types.js";

function add(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function percentile(
  histogram: HistogramReport,
  percentileValue: number,
): number | null {
  if (histogram.count === 0) return null;
  const target = Math.ceil(histogram.count * percentileValue);
  let cumulative = 0;
  for (const bucket of histogram.buckets) {
    cumulative += bucket.count;
    if (cumulative >= target) return bucket.leMs ?? histogram.maxMs;
  }
  return histogram.maxMs;
}

export function aggregateHistograms(
  histograms: HistogramReport[],
): AggregatedHistogram {
  const first = histograms[0];
  if (first === undefined) {
    throw new TypeError("at least one histogram is required");
  }
  const boundaries = first.buckets.map(({ leMs }) => leMs);
  for (const histogram of histograms) {
    if (
      histogram.buckets.length !== boundaries.length ||
      histogram.buckets.some(({ leMs }, index) => leMs !== boundaries[index])
    ) {
      throw new TypeError("ingestor histogram buckets do not match");
    }
  }
  const merged: HistogramReport = {
    count: add(histograms.map(({ count }) => count)),
    sumMs: add(histograms.map(({ sumMs }) => sumMs)),
    minMs:
      histograms
        .flatMap(({ minMs }) => (minMs === null ? [] : [minMs]))
        .sort((left, right) => left - right)[0] ?? null,
    maxMs:
      histograms
        .flatMap(({ maxMs }) => (maxMs === null ? [] : [maxMs]))
        .sort((left, right) => right - left)[0] ?? null,
    buckets: boundaries.map((leMs, index) => ({
      leMs,
      count: add(
        histograms.map((histogram) => histogram.buckets[index]?.count ?? 0),
      ),
    })),
  };
  return {
    ...merged,
    p50Ms: percentile(merged, 0.5),
    p95Ms: percentile(merged, 0.95),
    p99Ms: percentile(merged, 0.99),
  };
}

function assertSameTestId(
  testId: string,
  reports: Array<{ testId: string; sessionId: string }>,
): void {
  const mismatch = reports.find((report) => report.testId !== testId);
  if (mismatch !== undefined) {
    throw new TypeError(
      `testId mismatch: expected ${testId}, got ${mismatch.testId} (${mismatch.sessionId})`,
    );
  }
}

function assertSessionsCanBeSeparated(reports: GeneratorReport[]): void {
  for (const [index, report] of reports.entries()) {
    const deviceIds = new Set(report.devices.map(({ deviceId }) => deviceId));
    const startedAt = new Date(report.startedAt).getTime();
    const endedAt = new Date(report.endedAt).getTime();
    for (const other of reports.slice(index + 1)) {
      const overlapsDevice = other.devices.some(({ deviceId }) =>
        deviceIds.has(deviceId),
      );
      const overlapsTime =
        startedAt <= new Date(other.endedAt).getTime() &&
        new Date(other.startedAt).getTime() <= endedAt;
      if (overlapsDevice && overlapsTime) {
        throw new TypeError(
          `sessions ${report.sessionId} and ${other.sessionId} overlap for the same device`,
        );
      }
    }
  }
}

export async function createLoadTestReport(
  testId: string,
  generatorReports: GeneratorReport[],
  ingestorReports: IngestorReport[],
  repository: LoadReportRepository,
  now: () => Date = () => new Date(),
): Promise<LoadTestReport> {
  if (generatorReports.length === 0 || ingestorReports.length === 0) {
    throw new TypeError("generator and ingestor reports are required");
  }
  assertSameTestId(testId, [...generatorReports, ...ingestorReports]);
  assertSessionsCanBeSeparated(generatorReports);

  const sessions = await Promise.all(
    generatorReports.map(async (report) => {
      const deviceIds = report.devices.map(({ deviceId }) => deviceId);
      const rows = await repository.findTelemetry({
        deviceIds,
        startedAt: new Date(report.startedAt),
        endedAt: new Date(report.endedAt),
      });
      const devices = report.devices.map((device) => {
        const sequences = rows
          .filter(({ deviceId }) => deviceId === device.deviceId)
          .map(({ sequence }) => sequence)
          .sort((left, right) => left - right);
        return {
          deviceId: device.deviceId,
          sentSucceeded: device.succeeded,
          dbPersisted: sequences.length,
          missing: Math.max(0, device.succeeded - sequences.length),
          sequences,
        };
      });
      return {
        sessionId: report.sessionId,
        startedAt: report.startedAt,
        endedAt: report.endedAt,
        deviceIds,
        counters: {
          attempted: report.counters.attempted,
          sentSucceeded: report.counters.succeeded,
          sentFailed: report.counters.failed,
          dbPersisted: rows.length,
          missing: add(devices.map(({ missing }) => missing)),
        },
        devices,
      };
    }),
  );

  const sentSucceeded = add(
    generatorReports.map(({ counters }) => counters.succeeded),
  );
  const dbPersisted = add(sessions.map(({ counters }) => counters.dbPersisted));
  const missing = Math.max(0, sentSucceeded - dbPersisted);
  const ingestorCounters = ingestorReports.map(({ counters }) => counters);
  return {
    schemaVersion: 1,
    testId,
    generatedAt: now().toISOString(),
    startedAt: generatorReports
      .map(({ startedAt }) => startedAt)
      .sort()[0] as string,
    endedAt: generatorReports
      .map(({ endedAt }) => endedAt)
      .sort()
      .at(-1) as string,
    counters: {
      attempted: add(
        generatorReports.map(({ counters }) => counters.attempted),
      ),
      sentSucceeded,
      sentFailed: add(generatorReports.map(({ counters }) => counters.failed)),
      mqttReceived: add(
        ingestorCounters.map(({ mqttReceived }) => mqttReceived),
      ),
      validationSucceeded: add(
        ingestorCounters.map(({ validationSucceeded }) => validationSucceeded),
      ),
      validationFailed: add(
        ingestorCounters.map(({ validationFailed }) => validationFailed),
      ),
      dbSaveSucceeded: add(
        ingestorCounters.map(({ dbSaveSucceeded }) => dbSaveSucceeded),
      ),
      dbSaveFailed: add(
        ingestorCounters.map(({ dbSaveFailed }) => dbSaveFailed),
      ),
      dbPersisted,
      telemetryDuplicates: add(
        ingestorCounters.map((counter) => counter.telemetryDuplicates ?? 0),
      ),
      telemetryConflicts: add(
        ingestorCounters.map((counter) => counter.telemetryConflicts ?? 0),
      ),
      missing,
      missingRate: sentSucceeded === 0 ? 0 : missing / sentSucceeded,
      offlineTransitions: add(
        ingestorCounters.map(({ offlineTransitions }) => offlineTransitions),
      ),
    },
    timings: {
      deviceTimestampToMqttReceiveMs: aggregateHistograms(
        ingestorReports.map(
          ({ timings }) => timings.deviceTimestampToMqttReceiveMs,
        ),
      ),
      mqttReceiveToDbCompleteMs: aggregateHistograms(
        ingestorReports.map(({ timings }) => timings.mqttReceiveToDbCompleteMs),
      ),
    },
    sessions,
  };
}

export function assertCompleteReport(report: LoadTestReport): void {
  const { counters } = report;
  const mismatches = [
    ["送信成功とMQTT受信", counters.sentSucceeded, counters.mqttReceived],
    [
      "送信成功と検証成功",
      counters.sentSucceeded,
      counters.validationSucceeded,
    ],
    ["送信成功とDB保存成功", counters.sentSucceeded, counters.dbSaveSucceeded],
    ["送信成功と実保存件数", counters.sentSucceeded, counters.dbPersisted],
  ].filter(([, expected, actual]) => expected !== actual);
  if (
    counters.sentFailed > 0 ||
    counters.validationFailed > 0 ||
    counters.dbSaveFailed > 0 ||
    counters.telemetryConflicts > 0
  ) {
    mismatches.push([
      "失敗カウンタ",
      0,
      counters.sentFailed +
        counters.validationFailed +
        counters.dbSaveFailed +
        counters.telemetryConflicts,
    ]);
  }
  if (mismatches.length > 0) {
    throw new Error(
      `負荷試験の件数が一致しません: ${mismatches
        .map(
          ([label, expected, actual]) =>
            `${label} expected=${expected} actual=${actual}`,
        )
        .join(", ")}; sessions=${report.sessions
        .map(
          ({ sessionId, counters: session }) =>
            `${sessionId}(sent=${session.sentSucceeded},db=${session.dbPersisted},missing=${session.missing})`,
        )
        .join(",")}`,
    );
  }
}

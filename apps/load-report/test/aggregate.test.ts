import { describe, expect, it } from "vitest";

import {
  assertCompleteReport,
  createLoadTestReport,
} from "../src/aggregate.js";
import type {
  GeneratorReport,
  HistogramReport,
  IngestorReport,
  LoadReportRepository,
} from "../src/types.js";

function generator(
  sessionId: string,
  startedAt: string,
  endedAt: string,
  deviceId = "load-000001",
): GeneratorReport {
  return {
    schemaVersion: 1,
    testId: "test-1",
    sessionId,
    config: { deviceStart: 1, deviceCount: 1 },
    startedAt,
    endedAt,
    counters: { attempted: 2, succeeded: 2, failed: 0 },
    devices: [
      { deviceId, attempted: 2, succeeded: 2, failed: 0, lastSequence: 1 },
    ],
  };
}

function histogram(counts: number[]): HistogramReport {
  return {
    count: counts.reduce((total, count) => total + count, 0),
    sumMs: 35,
    minMs: 5,
    maxMs: 20,
    buckets: [
      { leMs: 10, count: counts[0] ?? 0 },
      { leMs: 20, count: counts[1] ?? 0 },
      { leMs: null, count: counts[2] ?? 0 },
    ],
  };
}

function ingestor(): IngestorReport {
  return {
    schemaVersion: 1,
    testId: "test-1",
    sessionId: "ingestor-1",
    startedAt: "2026-10-01T00:00:00.000Z",
    endedAt: "2026-10-01T00:00:10.000Z",
    counters: {
      mqttReceived: 4,
      validationSucceeded: 4,
      validationFailed: 0,
      dbSaveSucceeded: 4,
      dbSaveFailed: 0,
      offlineTransitions: 1,
    },
    timings: {
      deviceTimestampToMqttReceiveMs: histogram([1, 2, 1]),
      mqttReceiveToDbCompleteMs: histogram([2, 1, 1]),
    },
  };
}

describe("createLoadTestReport", () => {
  it("aggregates duplicates and rejects content conflicts", async () => {
    const input = ingestor();
    input.counters.telemetryDuplicates = 2;
    input.counters.telemetryConflicts = 1;
    const report = await createLoadTestReport(
      "test-1",
      [
        generator(
          "worker-1",
          "2026-10-01T00:00:01.000Z",
          "2026-10-01T00:00:02.000Z",
        ),
        generator(
          "worker-2",
          "2026-10-01T00:00:03.000Z",
          "2026-10-01T00:00:04.000Z",
        ),
      ],
      [input],
      {
        findTelemetry: async () => [
          { deviceId: "load-000001", sequence: 0 },
          { deviceId: "load-000001", sequence: 1 },
        ],
      },
    );
    expect(report.counters).toMatchObject({
      telemetryDuplicates: 2,
      telemetryConflicts: 1,
    });
    expect(() => assertCompleteReport(report)).toThrow(
      "失敗カウンタ expected=0 actual=1",
    );
  });
  it("keeps sequence resets separate by session time window", async () => {
    const first = generator(
      "worker-1",
      "2026-10-01T00:00:01.000Z",
      "2026-10-01T00:00:02.000Z",
    );
    const second = generator(
      "worker-2",
      "2026-10-01T00:00:03.000Z",
      "2026-10-01T00:00:04.000Z",
    );
    const repository: LoadReportRepository = {
      async findTelemetry({ startedAt }) {
        return startedAt.getUTCSeconds() === 1
          ? [
              { deviceId: "load-000001", sequence: 0 },
              { deviceId: "load-000001", sequence: 1 },
            ]
          : [
              { deviceId: "load-000001", sequence: 0 },
              { deviceId: "load-000001", sequence: 1 },
            ];
      },
    };

    const report = await createLoadTestReport(
      "test-1",
      [first, second],
      [ingestor()],
      repository,
      () => new Date("2026-10-01T00:00:05.000Z"),
    );

    expect(report.counters).toMatchObject({
      sentSucceeded: 4,
      mqttReceived: 4,
      dbSaveSucceeded: 4,
      dbPersisted: 4,
      missing: 0,
      missingRate: 0,
      offlineTransitions: 1,
    });
    expect(report.sessions.map(({ devices }) => devices[0]?.sequences)).toEqual(
      [
        [0, 1],
        [0, 1],
      ],
    );
    expect(report.timings.deviceTimestampToMqttReceiveMs).toMatchObject({
      p50Ms: 20,
      p95Ms: 20,
      p99Ms: 20,
    });
    expect(() => assertCompleteReport(report)).not.toThrow();
  });

  it("rejects overlapping sessions for the same device", async () => {
    const repository: LoadReportRepository = { findTelemetry: async () => [] };
    await expect(
      createLoadTestReport(
        "test-1",
        [
          generator(
            "worker-1",
            "2026-10-01T00:00:01.000Z",
            "2026-10-01T00:00:03.000Z",
          ),
          generator(
            "worker-2",
            "2026-10-01T00:00:02.000Z",
            "2026-10-01T00:00:04.000Z",
          ),
        ],
        [ingestor()],
        repository,
      ),
    ).rejects.toThrow("overlap for the same device");
  });

  it("reports session counts when persistence is missing", async () => {
    const repository: LoadReportRepository = {
      findTelemetry: async () => [{ deviceId: "load-000001", sequence: 0 }],
    };
    const report = await createLoadTestReport(
      "test-1",
      [
        generator(
          "worker-1",
          "2026-10-01T00:00:01.000Z",
          "2026-10-01T00:00:02.000Z",
        ),
      ],
      [
        {
          ...ingestor(),
          counters: {
            ...ingestor().counters,
            mqttReceived: 2,
            validationSucceeded: 2,
            dbSaveSucceeded: 2,
          },
        },
      ],
      repository,
    );

    expect(report.counters).toMatchObject({
      sentSucceeded: 2,
      dbPersisted: 1,
      missing: 1,
      missingRate: 0.5,
    });
    expect(() => assertCompleteReport(report)).toThrow(
      /送信成功と実保存件数 expected=2 actual=1.*worker-1\(sent=2,db=1,missing=1\)/,
    );
  });
});

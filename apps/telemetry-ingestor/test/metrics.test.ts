import { describe, expect, it, vi } from "vitest";

import { createLoadMetrics } from "../src/metrics.js";

describe("createLoadMetrics", () => {
  it("keeps stage counters and the two timing distributions separate", () => {
    const metrics = createLoadMetrics(
      {
        testId: "test-1",
        sessionId: "ingestor-a",
        reportPath: "/tmp/metrics.json",
      },
      { now: () => new Date("2026-10-01T00:00:00.000Z") },
    );

    metrics.recordMqttReceived();
    metrics.recordMqttReceived();
    metrics.recordValidationSuccess(
      "2026-09-30T23:59:59.750Z",
      new Date("2026-10-01T00:00:00.000Z"),
    );
    metrics.recordValidationFailure();
    metrics.recordDbSaveSuccess(12.5);
    metrics.recordDbSaveFailure(40);
    metrics.recordOfflineTransitions(3);

    const report = metrics.snapshot(new Date("2026-10-01T00:00:01.000Z"));
    expect(report.counters).toEqual({
      mqttReceived: 2,
      validationSucceeded: 1,
      validationFailed: 1,
      dbSaveSucceeded: 1,
      dbSaveFailed: 1,
      offlineTransitions: 3,
    });
    expect(report.timings.deviceTimestampToMqttReceiveMs).toMatchObject({
      count: 1,
      sumMs: 250,
      minMs: 250,
      maxMs: 250,
    });
    expect(report.timings.mqttReceiveToDbCompleteMs).toMatchObject({
      count: 2,
      sumMs: 52.5,
      minMs: 12.5,
      maxMs: 40,
    });
    expect(
      report.timings.mqttReceiveToDbCompleteMs.buckets.reduce(
        (sum, bucket) => sum + bucket.count,
        0,
      ),
    ).toBe(2);
  });

  it("writes a machine-readable report with test and session IDs", async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const metrics = createLoadMetrics(
      {
        testId: "test-1",
        sessionId: "ingestor-a",
        reportPath: "/tmp/metrics.json",
      },
      {
        now: () => new Date("2026-10-01T00:00:00.000Z"),
        writeFile,
      },
    );

    const report = await metrics.writeReport(
      new Date("2026-10-01T00:01:00.000Z"),
    );

    expect(writeFile).toHaveBeenCalledWith("/tmp/metrics.json", report);
    expect(report).toMatchObject({
      schemaVersion: 1,
      testId: "test-1",
      sessionId: "ingestor-a",
      startedAt: "2026-10-01T00:00:00.000Z",
      endedAt: "2026-10-01T00:01:00.000Z",
    });
  });
});

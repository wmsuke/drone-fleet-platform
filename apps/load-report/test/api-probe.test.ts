import { describe, expect, it, vi } from "vitest";

import { runApiProbe } from "../src/api-probe.js";

describe("runApiProbe", () => {
  it("records latency, errors, and timeouts", async () => {
    const monotonicValues = [0, 0, 0, 10, 10, 50, 50, 70, 100];
    const monotonicNow = vi.fn(() => monotonicValues.shift() ?? 100);
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
      } as unknown as Response)
      .mockRejectedValueOnce(timeout);

    const report = await runApiProbe(
      {
        testId: "test-1",
        targetUrl: "http://api/devices",
        durationMs: 100,
        intervalMs: 20,
        timeoutMs: 50,
      },
      {
        fetch: request,
        monotonicNow,
        now: () => new Date("2026-10-01T00:00:00.000Z"),
        wait: vi.fn().mockResolvedValue(undefined),
      },
    );

    expect(report.counters).toEqual({
      attempted: 2,
      succeeded: 1,
      failed: 1,
      timedOut: 1,
    });
    expect(report.errorRate).toBe(0.5);
    expect(report.timings).toEqual({
      minMs: 10,
      maxMs: 10,
      p50Ms: 10,
      p95Ms: 10,
      p99Ms: 10,
    });
  });

  it("waits for the response body before recording latency", async () => {
    let finishBody: (() => void) | undefined;
    const bodyCompleted = new Promise<ArrayBuffer>((resolve) => {
      finishBody = () => resolve(new ArrayBuffer(0));
    });
    const monotonicValues = [0, 0, 0, 25, 25, 25];
    const probe = runApiProbe(
      {
        testId: "test-1",
        targetUrl: "http://api/devices",
        durationMs: 1,
        intervalMs: 1,
        timeoutMs: 50,
      },
      {
        fetch: vi.fn<typeof fetch>().mockResolvedValue({
          ok: true,
          arrayBuffer: () => bodyCompleted,
        } as unknown as Response),
        monotonicNow: vi.fn(() => monotonicValues.shift() ?? 25),
        now: () => new Date("2026-10-01T00:00:00.000Z"),
        wait: vi.fn().mockResolvedValue(undefined),
      },
    );
    let settled = false;
    void probe.then(() => {
      settled = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    finishBody?.();
    const report = await probe;

    expect(report.counters.succeeded).toBe(1);
    expect(report.timings.p95Ms).toBe(25);
  });
});

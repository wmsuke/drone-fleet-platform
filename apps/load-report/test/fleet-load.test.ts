import { expect, it } from "vitest";
import {
  assessFleet,
  distribution,
  expectedOutcome,
} from "../src/fleet-load.js";
import type { ApiProbeReport } from "../src/api-probe.js";
it("uses nearest-rank percentiles and keeps missing observations null", () => {
  expect(distribution([])).toMatchObject({ count: 0, p95Ms: null });
  expect(distribution([10, 1, 3, 8, 2])).toEqual({
    count: 5,
    minMs: 1,
    p50Ms: 3,
    p95Ms: 10,
    p99Ms: 10,
    maxMs: 10,
  });
});
it("does not pass empty, slow, incomplete or failing trials", () => {
  const api = {
    timings: { p95Ms: 499 },
    counters: { attempted: 1000, timedOut: 0 },
    errorRate: 0.009,
  } as ApiProbeReport;
  expect(
    Object.values(
      assessFleet(100, 5000, api, {
        targets: 100,
        commands: 100,
        outboxes: 100,
      }),
    ).every(Boolean),
  ).toBe(true);
  expect(
    assessFleet(
      100,
      5001,
      {
        ...api,
        timings: { ...api.timings, p95Ms: 500 },
        errorRate: 0.01,
        counters: { ...api.counters, timedOut: 1 },
      },
      { targets: 100, commands: 99, outboxes: 100 },
    ),
  ).toEqual({
    acceptance: false,
    detailLatency: false,
    apiErrors: false,
    noMissingRows: false,
    noTimeouts: false,
  });
  expect(
    assessFleet(
      10,
      1,
      { ...api, counters: { ...api.counters, attempted: 0 } },
      { targets: 10, commands: 10, outboxes: 10 },
    ).apiErrors,
  ).toBe(false);
});
it("requires the scenario-specific aggregate rather than any terminal status", () => {
  expect(
    expectedOutcome(100, "unresponsive", {
      status: "PARTIALLY_FAILED",
      counts: { SUCCEEDED: 90, UNRESPONSIVE: 10 },
    }),
  ).toBe(true);
  expect(
    expectedOutcome(100, "failure", {
      status: "PARTIALLY_FAILED",
      counts: { SUCCEEDED: 90, EXECUTION_FAILED: 10 },
    }),
  ).toBe(true);
  expect(
    expectedOutcome(100, "success", {
      status: "COMPLETED",
      counts: { SUCCEEDED: 100 },
    }),
  ).toBe(true);
  expect(
    expectedOutcome(100, "unresponsive", {
      status: "FAILED",
      counts: { SUCCEEDED: 0, UNRESPONSIVE: 100 },
    }),
  ).toBe(false);
  expect(expectedOutcome(100, "success", undefined)).toBe(false);
});

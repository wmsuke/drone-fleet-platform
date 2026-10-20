import { expect, it } from "vitest";
import {
  firstVisibleMs,
  summarizeResources,
} from "../src/fleet-observations.js";
it("preserves sampled resource peaks without treating CPU percent as a single-core fraction", () => {
  expect(
    summarizeResources([
      {
        at: "",
        data: [
          {
            Name: "fleet-load-20261020-100-success-1-postgres-1",
            CPUPerc: "125.50%",
            MemUsage: "100MiB / 8GiB",
          },
        ],
      },
      {
        at: "",
        data: [
          {
            Name: "fleet-load-20261020-100-success-1-postgres-1",
            CPUPerc: "80%",
            MemUsage: "110MiB / 8GiB",
          },
        ],
      },
    ]),
  ).toEqual([
    {
      name: "postgres",
      maxCpuPercent: 125.5,
      maxMemoryBytes: 110 * 1024 ** 2,
      samples: 2,
    },
  ]);
  expect(() =>
    summarizeResources([
      { at: "", data: [{ Name: "bad", CPUPerc: "bad", MemUsage: "bad" }] },
    ]),
  ).toThrow();
});
it("uses the first actually observed committed count and returns null when incomplete", () => {
  const samples = [
    { at: "2026-10-20T00:00:00.500Z", acknowledged: 9, finished: 0 },
    { at: "2026-10-20T00:00:01.000Z", acknowledged: 10, finished: 9 },
  ];
  expect(
    firstVisibleMs(samples, "2026-10-20T00:00:00Z", 10, "acknowledged"),
  ).toBe(1000);
  expect(
    firstVisibleMs(samples, "2026-10-20T00:00:00Z", 10, "finished"),
  ).toBeNull();
});

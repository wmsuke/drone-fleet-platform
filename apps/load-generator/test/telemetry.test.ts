import { telemetryMessageSchema } from "@drone-fleet/protocol";
import { describe, expect, it } from "vitest";

import { createLoadTelemetry } from "../src/telemetry.js";

describe("createLoadTelemetry", () => {
  it("reproduces the same payload for the same seed, device and sequence", () => {
    const first = createLoadTelemetry(
      "load-000123",
      42,
      "2026-10-01T00:00:00.000Z",
      "seed-a",
    );
    const second = createLoadTelemetry(
      "load-000123",
      42,
      "2026-10-02T00:00:00.000Z",
      "seed-a",
    );

    expect(second.payload).toEqual(first.payload);
    expect(second.sequence).toBe(first.sequence);
  });

  it("changes the series for another seed or device", () => {
    const baseline = createLoadTelemetry(
      "load-000123",
      42,
      "2026-10-01T00:00:00.000Z",
      "seed-a",
    );

    expect(
      createLoadTelemetry(
        "load-000123",
        42,
        "2026-10-01T00:00:00.000Z",
        "seed-b",
      ).payload,
    ).not.toEqual(baseline.payload);
    expect(
      createLoadTelemetry(
        "load-000124",
        42,
        "2026-10-01T00:00:00.000Z",
        "seed-a",
      ).payload,
    ).not.toEqual(baseline.payload);
  });

  it("uses only the production telemetry schema", () => {
    const telemetry = createLoadTelemetry(
      "load-000001",
      0,
      "2026-10-01T00:00:00.000Z",
      "seed-a",
    );

    expect(telemetryMessageSchema.safeParse(telemetry).success).toBe(true);
    expect(Object.keys(telemetry).sort()).toEqual([
      "deviceId",
      "payload",
      "schemaVersion",
      "sequence",
      "timestamp",
    ]);
  });
});

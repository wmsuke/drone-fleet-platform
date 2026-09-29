import type { TelemetryMessage } from "@drone-fleet/protocol";
import { describe, expect, it } from "vitest";

import { toNewTelemetry } from "../src/repository.js";

describe("toNewTelemetry", () => {
  it("maps protocol telemetry to separate device and server timestamps", () => {
    const receivedAt = new Date("2026-09-29T02:00:01.000Z");
    const message: TelemetryMessage = {
      schemaVersion: 1,
      deviceId: "drone-001",
      sequence: 12,
      timestamp: "2026-09-29T02:00:00.000Z",
      payload: {
        battery: 80,
        latitude: 35.681236,
        longitude: 139.767125,
        altitude: 20,
        temperature: 25,
        status: "FLYING",
      },
    };

    expect(toNewTelemetry(message, receivedAt)).toEqual({
      deviceId: "drone-001",
      sequence: 12,
      deviceTimestamp: new Date("2026-09-29T02:00:00.000Z"),
      receivedAt,
      battery: 80,
      latitude: 35.681236,
      longitude: 139.767125,
      altitude: 20,
      temperature: 25,
      flightStatus: "FLYING",
    });
  });
});

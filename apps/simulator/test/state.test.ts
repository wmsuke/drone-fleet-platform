import { telemetryMessageSchema } from "@drone-fleet/protocol";
import { describe, expect, it } from "vitest";

import { createTelemetryMessage } from "../src/messages.js";
import { calculateDroneState } from "../src/state.js";

const timestamp = "2026-09-25T08:00:00.000Z";

describe("calculateDroneState", () => {
  it("changes every telemetry value over consecutive steps", () => {
    const first = calculateDroneState(1);
    const second = calculateDroneState(2);

    expect(second.battery).toBeLessThan(first.battery);
    expect(second.latitude).not.toBe(first.latitude);
    expect(second.longitude).not.toBe(first.longitude);
    expect(second.altitude).not.toBe(first.altitude);
    expect(second.temperature).not.toBe(first.temperature);
  });

  it("returns the same state series for the same seed and device", () => {
    const first = Array.from({ length: 20 }, (_, sequence) =>
      calculateDroneState(sequence, "demo-seed", "drone-004"),
    );
    const second = Array.from({ length: 20 }, (_, sequence) =>
      calculateDroneState(sequence, "demo-seed", "drone-004"),
    );

    expect(second).toEqual(first);
  });

  it("changes the state series when the seed changes", () => {
    const first = Array.from({ length: 20 }, (_, sequence) =>
      calculateDroneState(sequence, "seed-a", "drone-001"),
    );
    const second = Array.from({ length: 20 }, (_, sequence) =>
      calculateDroneState(sequence, "seed-b", "drone-001"),
    );

    expect(second).not.toEqual(first);
  });

  it("creates a stable, distinct series for each device", () => {
    const firstDevice = Array.from({ length: 20 }, (_, sequence) =>
      calculateDroneState(sequence, "fleet-seed", "drone-001"),
    );
    const secondDevice = Array.from({ length: 20 }, (_, sequence) =>
      calculateDroneState(sequence, "fleet-seed", "drone-002"),
    );

    expect(secondDevice).not.toEqual(firstDevice);
    expect(
      Array.from({ length: 20 }, (_, sequence) =>
        calculateDroneState(sequence, "fleet-seed", "drone-002"),
      ),
    ).toEqual(secondDevice);
  });

  it("stops battery depletion at zero", () => {
    expect(calculateDroneState(200).battery).toBe(0);
    expect(calculateDroneState(Number.MAX_SAFE_INTEGER).battery).toBe(0);
  });

  it("compares reproducible messages without time-dependent timestamps", () => {
    const withoutTimestamp = (timestamp: string) =>
      Array.from({ length: 10 }, (_, sequence) => {
        const message = createTelemetryMessage(
          "drone-003",
          sequence,
          timestamp,
          undefined,
          "repeatable-demo",
        );
        return {
          schemaVersion: message.schemaVersion,
          deviceId: message.deviceId,
          sequence: message.sequence,
          payload: message.payload,
        };
      });

    expect(withoutTimestamp("2026-09-25T08:00:00.000Z")).toEqual(
      withoutTimestamp("2026-10-01T09:30:00.000Z"),
    );
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid sequence: %s",
    (sequence) => {
      expect(() => calculateDroneState(sequence)).toThrow(TypeError);
    },
  );

  it("keeps all generated values inside the protocol ranges", () => {
    for (let sequence = 0; sequence <= 240; sequence += 1) {
      const message = createTelemetryMessage(
        "drone-001",
        sequence,
        timestamp,
        undefined,
        "range-test",
      );

      expect(telemetryMessageSchema.safeParse(message).success).toBe(true);
    }
  });
});

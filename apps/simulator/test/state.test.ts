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

  it("returns the same state for the same sequence", () => {
    expect(calculateDroneState(17)).toEqual(calculateDroneState(17));
  });

  it("starts at the configured base state", () => {
    expect(calculateDroneState(0)).toEqual({
      battery: 100,
      latitude: 35.681236,
      longitude: 139.768125,
      altitude: 0,
      temperature: 25,
      status: "IDLE",
    });
  });

  it("reaches the altitude and temperature boundaries", () => {
    expect(calculateDroneState(10).temperature).toBe(30);
    expect(calculateDroneState(20).altitude).toBe(50);
    expect(calculateDroneState(20).status).toBe("FLYING");
    expect(calculateDroneState(30).temperature).toBe(20);
    expect(calculateDroneState(40).altitude).toBe(0);
    expect(calculateDroneState(40).status).toBe("IDLE");
  });

  it("stops battery depletion at zero", () => {
    expect(calculateDroneState(199).battery).toBe(0.5);
    expect(calculateDroneState(200).battery).toBe(0);
    expect(calculateDroneState(Number.MAX_SAFE_INTEGER).battery).toBe(0);
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid sequence: %s",
    (sequence) => {
      expect(() => calculateDroneState(sequence)).toThrow(TypeError);
    },
  );

  it("keeps all generated values inside the protocol ranges", () => {
    for (let sequence = 0; sequence <= 240; sequence += 1) {
      const message = createTelemetryMessage("drone-001", sequence, timestamp);

      expect(telemetryMessageSchema.safeParse(message).success).toBe(true);
    }
  });
});

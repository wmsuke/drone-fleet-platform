import { describe, expect, it } from "vitest";

import { telemetryMessageSchema, type TelemetryMessage } from "../src/index.js";

const validTelemetry = {
  schemaVersion: 1,
  deviceId: "drone-001",
  sequence: 1234,
  timestamp: "2026-09-25T08:00:00.000Z",
  payload: {
    battery: 78,
    latitude: 35.4,
    longitude: 139.6,
    altitude: 32,
    temperature: 48,
    status: "FLYING",
  },
} as const;
const sessionId = "a065e32b-c00b-452e-9cb1-3b52c43962fb";
const validV2Telemetry = {
  ...validTelemetry,
  schemaVersion: 2,
  sessionId,
} as const;

function withPayload(overrides: Record<string, unknown>): unknown {
  return {
    ...validTelemetry,
    payload: { ...validTelemetry.payload, ...overrides },
  };
}

describe("telemetryMessageSchema", () => {
  it("returns a typed telemetry message", () => {
    const telemetry: TelemetryMessage =
      telemetryMessageSchema.parse(validTelemetry);

    expect(telemetry).toEqual(validTelemetry);
  });

  it("accepts v2 and distinguishes equal sequences across sessions", () => {
    const first = telemetryMessageSchema.parse(validV2Telemetry);
    const second = telemetryMessageSchema.parse({
      ...validV2Telemetry,
      sessionId: "5f6a6190-3748-40a6-b0de-2f80dcab2207",
    });

    expect(first.schemaVersion).toBe(2);
    expect(first).toMatchObject({
      deviceId: "drone-001",
      sessionId,
      sequence: 1234,
    });
    expect(second).toMatchObject({ deviceId: "drone-001", sequence: 1234 });
    expect(second).not.toEqual(first);
  });

  it.each([
    ["missing", { ...validV2Telemetry, sessionId: undefined }],
    ["wrong type", { ...validV2Telemetry, sessionId: 42 }],
    ["malformed", { ...validV2Telemetry, sessionId: "not-a-uuid" }],
    [
      "wrong version",
      {
        ...validV2Telemetry,
        sessionId: "a065e32b-c00b-152e-9cb1-3b52c43962fb",
      },
    ],
    ["overlong", { ...validV2Telemetry, sessionId: `${sessionId}0` }],
  ])("rejects %s v2 sessionId", (_case, message) => {
    expect(telemetryMessageSchema.safeParse(message).success).toBe(false);
  });

  it("accepts numeric boundary values", () => {
    const result = telemetryMessageSchema.safeParse({
      ...validTelemetry,
      sequence: Number.MAX_SAFE_INTEGER,
      payload: {
        ...validTelemetry.payload,
        battery: 0,
        latitude: -90,
        longitude: 180,
        altitude: 0,
        temperature: -20,
        status: "RETURNING_HOME",
      },
    });

    expect(result.success).toBe(true);
  });

  it.each(["schemaVersion", "deviceId", "sequence", "timestamp", "payload"])(
    "rejects a missing %s",
    (field) => {
      const message: Record<string, unknown> = { ...validTelemetry };
      delete message[field];

      expect(telemetryMessageSchema.safeParse(message).success).toBe(false);
    },
  );

  it.each([
    "battery",
    "latitude",
    "longitude",
    "altitude",
    "temperature",
    "status",
  ])("rejects a missing payload.%s", (field) => {
    const payload: Record<string, unknown> = { ...validTelemetry.payload };
    delete payload[field];

    expect(
      telemetryMessageSchema.safeParse({ ...validTelemetry, payload }).success,
    ).toBe(false);
  });

  it.each([
    ["schemaVersion", { ...validTelemetry, schemaVersion: 2 }],
    ["deviceId", { ...validTelemetry, deviceId: "drone/001" }],
    ["sequence type", { ...validTelemetry, sequence: "1" }],
    ["negative sequence", { ...validTelemetry, sequence: -1 }],
    ["decimal sequence", { ...validTelemetry, sequence: 1.5 }],
    [
      "unsafe sequence",
      { ...validTelemetry, sequence: Number.MAX_SAFE_INTEGER + 1 },
    ],
    ["timestamp type", { ...validTelemetry, timestamp: 1 }],
    [
      "timestamp offset",
      { ...validTelemetry, timestamp: "2026-09-25T17:00:00.000+09:00" },
    ],
    [
      "timestamp without timezone",
      { ...validTelemetry, timestamp: "2026-09-25T08:00:00.000" },
    ],
    [
      "invalid calendar date",
      { ...validTelemetry, timestamp: "2026-02-30T08:00:00.000Z" },
    ],
    ["battery type", withPayload({ battery: "78" })],
    ["battery below range", withPayload({ battery: -1 })],
    ["battery above range", withPayload({ battery: 101 })],
    ["latitude type", withPayload({ latitude: "35.4" })],
    ["latitude below range", withPayload({ latitude: -91 })],
    ["latitude above range", withPayload({ latitude: 91 })],
    ["longitude type", withPayload({ longitude: "139.6" })],
    ["longitude below range", withPayload({ longitude: -181 })],
    ["longitude above range", withPayload({ longitude: 181 })],
    ["altitude type", withPayload({ altitude: "32" })],
    ["negative altitude", withPayload({ altitude: -0.1 })],
    ["infinite altitude", withPayload({ altitude: Number.POSITIVE_INFINITY })],
    ["temperature type", withPayload({ temperature: "48" })],
    [
      "infinite temperature",
      withPayload({ temperature: Number.NEGATIVE_INFINITY }),
    ],
    ["NaN temperature", withPayload({ temperature: Number.NaN })],
    ["flight status type", withPayload({ status: 1 })],
    ["unknown flight status", withPayload({ status: "LANDED" })],
  ])("rejects an invalid %s", (_name, message) => {
    expect(telemetryMessageSchema.safeParse(message).success).toBe(false);
  });

  it("ignores unknown fields", () => {
    const telemetry = telemetryMessageSchema.parse({
      ...validTelemetry,
      extra: "ignored",
      payload: {
        ...validTelemetry.payload,
        extra: "ignored",
      },
    });

    expect(telemetry).toEqual(validTelemetry);
  });
});

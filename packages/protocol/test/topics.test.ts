import { describe, expect, it } from "vitest";

import {
  createCommandAcksTopic,
  createCommandsTopic,
  createStatusTopic,
  createTelemetryTopic,
  createTelemetryReceiptsTopic,
  isValidDeviceId,
  parseMqttTopic,
} from "../src/index.js";

describe("MQTT topics", () => {
  it.each([
    [createTelemetryTopic, "telemetry"],
    [createTelemetryReceiptsTopic, "telemetry-receipts"],
    [createStatusTopic, "status"],
    [createCommandsTopic, "commands"],
    [createCommandAcksTopic, "command-acks"],
  ] as const)("generates and parses the %s topic", (createTopic, kind) => {
    const topic = createTopic("drone_ABC-123");

    expect(topic).toBe(`fleet/v1/devices/drone_ABC-123/${kind}`);
    expect(parseMqttTopic(topic)).toEqual({
      kind,
      deviceId: "drone_ABC-123",
    });
  });

  it("accepts deviceId boundary lengths", () => {
    expect(isValidDeviceId("a")).toBe(true);
    expect(isValidDeviceId("a".repeat(64))).toBe(true);
  });

  it.each([
    "",
    "a".repeat(65),
    "drone/001",
    "drone.001",
    "ドローン001",
    "drone+",
    "drone#",
  ])("rejects invalid deviceId: %s", (deviceId) => {
    expect(isValidDeviceId(deviceId)).toBe(false);
    expect(() => createTelemetryTopic(deviceId)).toThrow(TypeError);
  });

  it.each([
    "",
    "fleet/v1/devices",
    "fleet/v1/devices/drone-001",
    "fleet/v1/devices/drone-001/unknown",
    "fleet/v1/devices/drone-001/telemetry/extra",
    "fleet/v2/devices/drone-001/telemetry",
    "fleet/v1/device/drone-001/telemetry",
    "fleet/v1/devices/drone.001/telemetry",
    "fleet/v1/devices/+/telemetry",
    "fleet/v1/devices/drone-001/#",
  ])("rejects an invalid topic: %s", (topic) => {
    expect(parseMqttTopic(topic)).toBeNull();
  });
});

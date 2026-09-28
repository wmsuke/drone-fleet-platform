import {
  connectionStatusMessageSchema,
  telemetryMessageSchema,
} from "@drone-fleet/protocol";
import { describe, expect, it } from "vitest";

import {
  createConnectionLostMessage,
  createOnlineMessage,
  createShutdownMessage,
  createTelemetryMessage,
} from "../src/messages.js";

const timestamp = "2026-09-25T08:00:00.000Z";

describe("simulator messages", () => {
  it.each([
    [createOnlineMessage, "ONLINE", "CONNECTED"],
    [createShutdownMessage, "OFFLINE", "SHUTDOWN"],
    [createConnectionLostMessage, "OFFLINE", "CONNECTION_LOST"],
  ] as const)("creates a valid %s message", (createMessage, status, reason) => {
    const message = createMessage("drone-001", timestamp);

    expect(connectionStatusMessageSchema.parse(message)).toEqual(message);
    expect(message.payload).toEqual({ status, reason });
  });

  it("creates protocol-compliant telemetry", () => {
    const message = createTelemetryMessage("drone-001", 0, timestamp);

    expect(telemetryMessageSchema.parse(message)).toEqual(message);
    expect(message.sequence).toBe(0);
    expect(message.payload.status).toBe("IDLE");
  });

  it("changes battery according to sequence without leaving its range", () => {
    expect(
      createTelemetryMessage("drone-001", 1, timestamp).payload.battery,
    ).toBe(99);
    expect(
      createTelemetryMessage("drone-001", 100, timestamp).payload.battery,
    ).toBe(0);
    expect(
      createTelemetryMessage("drone-001", 101, timestamp).payload.battery,
    ).toBe(100);
  });
});

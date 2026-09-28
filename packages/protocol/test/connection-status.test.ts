import { describe, expect, it } from "vitest";

import {
  connectionStatusMessageSchema,
  type ConnectionStatusMessage,
} from "../src/index.js";

const baseMessage = {
  schemaVersion: 1,
  deviceId: "drone-001",
  timestamp: "2026-09-25T08:00:00.000Z",
} as const;

describe("connectionStatusMessageSchema", () => {
  it.each([
    ["ONLINE", "CONNECTED"],
    ["OFFLINE", "SHUTDOWN"],
    ["OFFLINE", "CONNECTION_LOST"],
  ] as const)("accepts %s / %s", (status, reason) => {
    const connectionStatus: ConnectionStatusMessage =
      connectionStatusMessageSchema.parse({
        ...baseMessage,
        payload: { status, reason },
      });

    expect(connectionStatus).toEqual({
      ...baseMessage,
      payload: { status, reason },
    });
  });

  it.each([
    ["ONLINE", "SHUTDOWN"],
    ["ONLINE", "CONNECTION_LOST"],
    ["OFFLINE", "CONNECTED"],
  ])("rejects %s / %s", (status, reason) => {
    expect(
      connectionStatusMessageSchema.safeParse({
        ...baseMessage,
        payload: { status, reason },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["unknown status", { status: "UNKNOWN", reason: "CONNECTED" }],
    ["unknown reason", { status: "OFFLINE", reason: "TIMEOUT" }],
    ["status type", { status: 1, reason: "CONNECTED" }],
    ["reason type", { status: "ONLINE", reason: 1 }],
    ["missing status", { reason: "CONNECTED" }],
    ["missing reason", { status: "ONLINE" }],
  ])("rejects an invalid %s", (_name, payload) => {
    expect(
      connectionStatusMessageSchema.safeParse({ ...baseMessage, payload })
        .success,
    ).toBe(false);
  });

  it.each(["schemaVersion", "deviceId", "timestamp", "payload"])(
    "rejects a missing %s",
    (field) => {
      const message: Record<string, unknown> = {
        ...baseMessage,
        payload: { status: "ONLINE", reason: "CONNECTED" },
      };
      delete message[field];

      expect(connectionStatusMessageSchema.safeParse(message).success).toBe(
        false,
      );
    },
  );

  it.each([
    ["schemaVersion", { ...baseMessage, schemaVersion: 2 }],
    ["deviceId", { ...baseMessage, deviceId: "drone/001" }],
    ["timestamp type", { ...baseMessage, timestamp: 1 }],
    [
      "timestamp offset",
      { ...baseMessage, timestamp: "2026-09-25T17:00:00.000+09:00" },
    ],
    [
      "timestamp without timezone",
      { ...baseMessage, timestamp: "2026-09-25T08:00:00.000" },
    ],
    [
      "invalid calendar date",
      { ...baseMessage, timestamp: "2026-02-30T08:00:00.000Z" },
    ],
  ])("rejects an invalid %s", (_name, message) => {
    expect(
      connectionStatusMessageSchema.safeParse({
        ...message,
        payload: { status: "ONLINE", reason: "CONNECTED" },
      }).success,
    ).toBe(false);
  });

  it("ignores unknown fields", () => {
    const connectionStatus = connectionStatusMessageSchema.parse({
      ...baseMessage,
      extra: "ignored",
      payload: {
        status: "OFFLINE",
        reason: "CONNECTION_LOST",
        extra: "ignored",
      },
    });

    expect(connectionStatus).toEqual({
      ...baseMessage,
      payload: {
        status: "OFFLINE",
        reason: "CONNECTION_LOST",
      },
    });
  });
});

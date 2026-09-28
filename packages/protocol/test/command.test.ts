import { describe, expect, it } from "vitest";

import {
  commandAcknowledgementMessageSchema,
  commandMessageSchema,
  type CommandAcknowledgementMessage,
  type CommandMessage,
} from "../src/index.js";

const commandId = "5c15de4f-6957-4f4f-b3cf-8cb9e733d63c";

const validCommand = {
  schemaVersion: 1,
  commandId,
  deviceId: "drone-001",
  type: "RETURN_HOME",
  timestamp: "2026-09-25T08:00:00.000Z",
} as const;

const validAcknowledgement = {
  schemaVersion: 1,
  commandId,
  deviceId: "drone-001",
  status: "ACKNOWLEDGED",
  timestamp: "2026-09-25T08:00:01.000Z",
} as const;

describe("commandMessageSchema", () => {
  it.each(["RETURN_HOME", "REBOOT"] as const)(
    "accepts a %s command",
    (type) => {
      const command: CommandMessage = commandMessageSchema.parse({
        ...validCommand,
        type,
      });

      expect(command).toEqual({ ...validCommand, type });
    },
  );

  it.each(["commandId", "deviceId", "type", "timestamp"])(
    "rejects a missing %s",
    (field) => {
      const command: Record<string, unknown> = { ...validCommand };
      delete command[field];

      expect(commandMessageSchema.safeParse(command).success).toBe(false);
    },
  );

  it.each([
    ["commandId format", { ...validCommand, commandId: "not-a-uuid" }],
    ["commandId type", { ...validCommand, commandId: 1 }],
    ["deviceId format", { ...validCommand, deviceId: "drone/001" }],
    ["deviceId type", { ...validCommand, deviceId: 1 }],
    ["command type", { ...validCommand, type: "LAND" }],
    ["command type value type", { ...validCommand, type: 1 }],
    ["schemaVersion", { ...validCommand, schemaVersion: 2 }],
    ["timestamp type", { ...validCommand, timestamp: 1 }],
    [
      "timestamp offset",
      { ...validCommand, timestamp: "2026-09-25T17:00:00.000+09:00" },
    ],
    [
      "timestamp without timezone",
      { ...validCommand, timestamp: "2026-09-25T08:00:00.000" },
    ],
  ])("rejects an invalid %s", (_name, command) => {
    expect(commandMessageSchema.safeParse(command).success).toBe(false);
  });

  it("ignores unknown fields", () => {
    expect(
      commandMessageSchema.parse({ ...validCommand, extra: "ignored" }),
    ).toEqual(validCommand);
  });
});

describe("commandAcknowledgementMessageSchema", () => {
  it("accepts an acknowledgement", () => {
    const acknowledgement: CommandAcknowledgementMessage =
      commandAcknowledgementMessageSchema.parse(validAcknowledgement);

    expect(acknowledgement).toEqual(validAcknowledgement);
  });

  it.each(["commandId", "deviceId", "status", "timestamp"])(
    "rejects a missing %s",
    (field) => {
      const acknowledgement: Record<string, unknown> = {
        ...validAcknowledgement,
      };
      delete acknowledgement[field];

      expect(
        commandAcknowledgementMessageSchema.safeParse(acknowledgement).success,
      ).toBe(false);
    },
  );

  it.each([
    ["commandId format", { ...validAcknowledgement, commandId: "not-a-uuid" }],
    ["commandId type", { ...validAcknowledgement, commandId: 1 }],
    ["deviceId format", { ...validAcknowledgement, deviceId: "drone/001" }],
    ["deviceId type", { ...validAcknowledgement, deviceId: 1 }],
    ["status", { ...validAcknowledgement, status: "COMPLETED" }],
    ["status type", { ...validAcknowledgement, status: 1 }],
    ["schemaVersion", { ...validAcknowledgement, schemaVersion: 2 }],
    ["timestamp type", { ...validAcknowledgement, timestamp: 1 }],
    [
      "timestamp offset",
      {
        ...validAcknowledgement,
        timestamp: "2026-09-25T17:00:01.000+09:00",
      },
    ],
    [
      "timestamp without timezone",
      { ...validAcknowledgement, timestamp: "2026-09-25T08:00:01.000" },
    ],
  ])("rejects an invalid %s", (_name, acknowledgement) => {
    expect(
      commandAcknowledgementMessageSchema.safeParse(acknowledgement).success,
    ).toBe(false);
  });

  it("ignores unknown fields", () => {
    expect(
      commandAcknowledgementMessageSchema.parse({
        ...validAcknowledgement,
        extra: "ignored",
      }),
    ).toEqual(validAcknowledgement);
  });
});

it("correlates an acknowledgement with its command", () => {
  const command = commandMessageSchema.parse(validCommand);
  const acknowledgement =
    commandAcknowledgementMessageSchema.parse(validAcknowledgement);

  expect(acknowledgement.commandId).toBe(command.commandId);
  expect(acknowledgement.deviceId).toBe(command.deviceId);
});

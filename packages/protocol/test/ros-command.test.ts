import { describe, expect, it } from "vitest";
import { commandMessageSchema, rosCommandMessageSchema } from "../src/index.js";

const command = {
  schemaVersion: 3,
  deviceId: "ros-ref-001",
  commandId: "5c15de4f-6957-4f4f-b3cf-8cb9e733d63c",
  type: "RETURN_HOME",
  targetKind: "ROS2",
  expectedConfigurationId: "a".repeat(64),
  timestamp: "2026-11-06T03:00:00.000Z",
  expiresAt: "2026-11-06T03:00:30.000Z",
  resultDeadline: "2026-11-06T03:02:00.000Z",
};

describe("ROS command v3", () => {
  it("keeps the simulator decoder separate until ROS delivery is enabled", () => {
    expect(rosCommandMessageSchema.parse(command)).toEqual(command);
    expect(commandMessageSchema.safeParse(command).success).toBe(false);
  });

  it.each([
    { targetKind: "SIMULATOR" },
    { type: "REBOOT" },
    { expectedConfigurationId: "A".repeat(64) },
    { expectedConfigurationId: undefined },
    { expiresAt: command.timestamp },
    { expiresAt: "2026-11-06T03:00:31.000Z" },
    { resultDeadline: command.expiresAt },
    { resultDeadline: "2026-11-06T03:02:01.000Z" },
    { resultDeadline: undefined },
    { arbitraryAction: "other" },
  ])("rejects an invalid contract: %j", (change) => {
    expect(
      rosCommandMessageSchema.safeParse({ ...command, ...change }).success,
    ).toBe(false);
  });
});

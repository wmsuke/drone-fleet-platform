import { describe, expect, it, vi } from "vitest";

import {
  createCommandPublisher,
  type CommandMqttClient,
} from "../src/command-publisher.js";

describe("createCommandPublisher", () => {
  it("publishes to the device commands topic with QoS 1 and no retain", async () => {
    const publishAsync = vi.fn(async () => undefined);
    const client: CommandMqttClient = { publishAsync };
    const publisher = createCommandPublisher(client);
    const command = {
      schemaVersion: 1 as const,
      commandId: "5c15de4f-6957-4f4f-b3cf-8cb9e733d63c",
      deviceId: "drone-001",
      type: "REBOOT" as const,
      timestamp: "2026-09-30T02:00:00.000Z",
    };

    await publisher.publish(command);

    expect(publishAsync).toHaveBeenCalledOnce();
    const call = publishAsync.mock.calls[0];
    expect(call?.[0]).toBe("fleet/v1/devices/drone-001/commands");
    expect(JSON.parse(call?.[1] ?? "null")).toEqual(command);
    expect(call?.[2]).toEqual({ qos: 1, retain: false });
  });
});

import { commandAcknowledgementMessageSchema } from "@drone-fleet/protocol";
import { describe, expect, it } from "vitest";

import { createCommandProcessor } from "../src/commands.js";

const commandId = "5c15de4f-6957-4f4f-b3cf-8cb9e733d63c";
const timestamp = "2026-09-25T08:00:01.000Z";

function commandPayload(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      commandId,
      deviceId: "drone-001",
      type: "RETURN_HOME",
      timestamp: "2026-09-25T08:00:00.000Z",
      ...overrides,
    }),
  );
}

describe("createCommandProcessor", () => {
  it("accepts a command for the simulator and creates its acknowledgement", () => {
    const processor = createCommandProcessor("drone-001");

    const result = processor.process(
      "fleet/v1/devices/drone-001/commands",
      commandPayload(),
      timestamp,
    );

    expect(result?.action).toBe("RETURN_HOME");
    expect(
      commandAcknowledgementMessageSchema.parse(result?.acknowledgement),
    ).toEqual({
      schemaVersion: 1,
      commandId,
      deviceId: "drone-001",
      status: "ACKNOWLEDGED",
      timestamp,
    });
  });

  it("acknowledges a duplicate without repeating its action", () => {
    const processor = createCommandProcessor("drone-001");
    const topic = "fleet/v1/devices/drone-001/commands";

    const first = processor.process(topic, commandPayload(), timestamp);
    const duplicate = processor.process(topic, commandPayload(), timestamp);

    expect(first?.action).toBe("RETURN_HOME");
    expect(duplicate?.action).toBeNull();
    expect(duplicate?.acknowledgement.commandId).toBe(commandId);
  });

  it.each([
    ["another topic", "fleet/v1/devices/drone-002/commands", commandPayload()],
    [
      "another device",
      "fleet/v1/devices/drone-001/commands",
      commandPayload({ deviceId: "drone-002" }),
    ],
    ["invalid JSON", "fleet/v1/devices/drone-001/commands", Buffer.from("{")],
    [
      "invalid command",
      "fleet/v1/devices/drone-001/commands",
      commandPayload({ type: "LAND" }),
    ],
  ])("ignores %s", (_name, topic, payload) => {
    const processor = createCommandProcessor("drone-001");

    expect(processor.process(topic, payload, timestamp)).toBeNull();
  });
});

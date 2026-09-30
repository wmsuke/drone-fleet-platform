import { connectAsync, type IPublishPacket } from "mqtt";
import { describe, expect, it } from "vitest";

import { createCommandPublisher } from "../src/command-publisher.js";

const runIntegration = process.env.MQTT_INTEGRATION === "true";
const integration = describe.skipIf(!runIntegration);
const topic = "fleet/v1/devices/integration-command-publisher/commands";

integration("command publisher", () => {
  it("publishes a non-retained QoS 1 command to Mosquitto", async () => {
    const subscriber = await connectAsync("mqtt://127.0.0.1:1883", {
      clean: true,
      clientId: "integration-command-subscriber",
    });
    const publisherClient = await connectAsync("mqtt://127.0.0.1:1883", {
      clean: true,
      clientId: "integration-command-publisher",
    });
    try {
      await subscriber.subscribeAsync(topic, { qos: 1 });
      const received = new Promise<{ payload: Buffer; packet: IPublishPacket }>(
        (resolve) => {
          subscriber.once("message", (_topic, payload, packet) => {
            resolve({ payload, packet });
          });
        },
      );
      const publisher = createCommandPublisher(publisherClient);
      const command = {
        schemaVersion: 1 as const,
        commandId: "5c15de4f-6957-4f4f-b3cf-8cb9e733d63c",
        deviceId: "integration-command-publisher",
        type: "RETURN_HOME" as const,
        timestamp: "2026-09-30T02:00:00.000Z",
      };

      await publisher.publish(command);
      const message = await received;

      expect(JSON.parse(message.payload.toString("utf8"))).toEqual(command);
      expect(message.packet.qos).toBe(1);
      expect(message.packet.retain).toBe(false);
    } finally {
      await Promise.all([
        subscriber.endAsync(false),
        publisherClient.endAsync(false),
      ]);
    }
  });
});

import {
  commandMessageSchema,
  createCommandsTopic,
  type CommandMessage,
} from "@drone-fleet/protocol";

export interface CommandMqttClient {
  publishAsync(
    topic: string,
    payload: string,
    options: { qos: 1; retain: false },
  ): Promise<unknown>;
}

export interface CommandPublisher {
  publish(message: CommandMessage): Promise<void>;
}

export function createCommandPublisher(
  client: CommandMqttClient,
): CommandPublisher {
  return {
    async publish(message) {
      const command = commandMessageSchema.parse(message);
      await client.publishAsync(
        createCommandsTopic(command.deviceId),
        JSON.stringify(command),
        { qos: 1, retain: false },
      );
    },
  };
}

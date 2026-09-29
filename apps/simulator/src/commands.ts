import {
  commandAcknowledgementMessageSchema,
  commandMessageSchema,
  createCommandsTopic,
  type CommandAcknowledgementMessage,
  type CommandMessage,
} from "@drone-fleet/protocol";

export interface ProcessedCommand {
  acknowledgement: CommandAcknowledgementMessage;
  action: CommandMessage["type"] | null;
}

export interface CommandProcessor {
  process(
    topic: string,
    payload: Buffer,
    timestamp: string,
  ): ProcessedCommand | null;
  markProcessed(commandId: string): void;
}

export function createCommandProcessor(deviceId: string): CommandProcessor {
  const commandsTopic = createCommandsTopic(deviceId);
  const processedCommandIds = new Set<string>();

  return {
    process(topic, payload, timestamp) {
      if (topic !== commandsTopic) {
        return null;
      }

      let input: unknown;
      try {
        input = JSON.parse(payload.toString("utf8"));
      } catch {
        return null;
      }

      const parsed = commandMessageSchema.safeParse(input);
      if (!parsed.success || parsed.data.deviceId !== deviceId) {
        return null;
      }

      const command = parsed.data;
      return {
        acknowledgement: commandAcknowledgementMessageSchema.parse({
          schemaVersion: 1,
          commandId: command.commandId,
          deviceId,
          status: "ACKNOWLEDGED",
          timestamp,
        }),
        action: processedCommandIds.has(command.commandId)
          ? null
          : command.type,
      };
    },
    markProcessed(commandId) {
      processedCommandIds.add(commandId);
    },
  };
}

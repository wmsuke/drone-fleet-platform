import {
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
  hasUnfinished(): boolean;
  process(
    topic: string,
    payload: Buffer,
    timestamp: string,
  ): ProcessedCommand | null;
  markProcessed(commandId: string): void;
  finish(
    commandId: string,
    timestamp: string,
    status: "SUCCEEDED" | "FAILED" | "UNCERTAIN",
  ): void;
  begin(commandId: string, timestamp: string): ProcessedCommand | null;
  recover(timestamp: string): ProcessedCommand[];
  pendingAcknowledgements(): CommandAcknowledgementMessage[];
  confirmAcknowledgement(ack: CommandAcknowledgementMessage): void;
  close(): void;
}

import { CommandStore, type CommandStoreOptions } from "./command-store.js";

export function createCommandProcessor(
  deviceId: string,
  options: CommandStoreOptions = {},
): CommandProcessor {
  const commandsTopic = createCommandsTopic(deviceId);
  const store = new CommandStore(deviceId, options);

  return {
    hasUnfinished: () => store.hasUnfinished(),
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
      return store.receive(command, timestamp);
    },
    markProcessed(commandId) {
      store.complete(commandId, new Date().toISOString());
    },
    finish: (id, timestamp, status) => store.finish(id, timestamp, status),
    begin: (id, timestamp) => store.begin(id, timestamp),
    recover: (timestamp) => store.recover(timestamp),
    pendingAcknowledgements: () => [
      ...store.pendingAcknowledgements(),
      ...store.pendingExecutions(),
    ],
    confirmAcknowledgement: (ack) => store.confirmAcknowledgement(ack),
    close: () => store.close(),
  };
}

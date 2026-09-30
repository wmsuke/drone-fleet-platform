import { randomUUID } from "node:crypto";

import type { CommandRepository } from "./command-repository.js";
import type { CommandPublisher } from "./command-publisher.js";
import type { CommandRequest, CommandResponse } from "./schema.js";

export class DeviceNotFoundError extends Error {}

export class CommandPublishError extends Error {
  constructor(public readonly command: CommandResponse) {
    super("command publish failed");
  }
}

export interface CommandService {
  send(
    deviceId: string,
    type: CommandRequest["type"],
  ): Promise<CommandResponse>;
}

export function createCommandService(
  repository: CommandRepository,
  publisher: CommandPublisher,
  generateId: () => string = randomUUID,
  now: () => Date = () => new Date(),
): CommandService {
  return {
    async send(deviceId, type) {
      const createdAt = now();
      const commandId = generateId();
      const pending = await repository.createPending({
        commandId,
        deviceId,
        type,
        createdAt,
      });
      if (pending === null) {
        throw new DeviceNotFoundError();
      }
      try {
        await publisher.publish({
          schemaVersion: 1,
          commandId,
          deviceId,
          type,
          timestamp: createdAt.toISOString(),
        });
      } catch {
        const failed = await repository.markFailed(commandId);
        throw new CommandPublishError(failed);
      }
      return repository.markSent(commandId, now());
    },
  };
}

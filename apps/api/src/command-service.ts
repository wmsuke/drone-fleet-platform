import { randomUUID } from "node:crypto";

import type { CommandRepository } from "./command-repository.js";
import type {
  CommandHistoryItem,
  CommandRequest,
  CommandResponse,
} from "./schema.js";

export class DeviceNotFoundError extends Error {}

export interface CommandService {
  send(
    deviceId: string,
    type: CommandRequest["type"],
  ): Promise<CommandResponse>;
  history(
    deviceId: string,
    limit: number,
  ): Promise<CommandHistoryItem[] | null>;
}

export function createCommandService(
  repository: CommandRepository,
  generateId: () => string = randomUUID,
  now: () => Date = () => new Date(),
): CommandService {
  return {
    history(deviceId, limit) {
      return repository.history(deviceId, limit);
    },
    async send(deviceId, type) {
      const createdAt = now();
      const commandId = generateId();
      const expiresAt = new Date(createdAt.getTime() + 30_000);
      const pending = await repository.createPending({
        commandId,
        deviceId,
        type,
        createdAt,
        expiresAt,
      });
      if (pending === null) {
        throw new DeviceNotFoundError();
      }
      return pending;
    },
  };
}

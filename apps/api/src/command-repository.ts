import {
  commands,
  commandOutbox,
  devices,
  type Database,
} from "@drone-fleet/database";
import {
  createCommandsTopic,
  commandMessageSchema,
} from "@drone-fleet/protocol";
import { and, desc, eq } from "drizzle-orm";

import type { CommandHistoryItem, CommandResponse } from "./schema.js";

export interface PendingCommand {
  commandId: string;
  deviceId: string;
  type: CommandResponse["type"];
  createdAt: Date;
  expiresAt?: Date;
}

export interface CommandRepository {
  createPending(command: PendingCommand): Promise<CommandResponse | null>;
  markSent(commandId: string, sentAt: Date): Promise<CommandResponse>;
  markFailed(commandId: string): Promise<CommandResponse>;
  history(
    deviceId: string,
    limit: number,
  ): Promise<CommandHistoryItem[] | null>;
}

export function createCommandRepository(database: Database): CommandRepository {
  async function findCommand(commandId: string): Promise<CommandResponse> {
    const rows = await database
      .select()
      .from(commands)
      .where(eq(commands.commandId, commandId))
      .limit(1);
    const command = rows[0];
    if (command === undefined) {
      throw new Error(`command not found: ${commandId}`);
    }
    return toCommandResponse(command);
  }

  return {
    async createPending(command) {
      return database.transaction(async (transaction) => {
        const registered = await transaction
          .select({ deviceId: devices.deviceId })
          .from(devices)
          .where(eq(devices.deviceId, command.deviceId))
          .limit(1);
        if (registered.length === 0) {
          return null;
        }
        await transaction.insert(commands).values({
          ...command,
          status: "PENDING",
        });
        if (command.expiresAt !== undefined) {
          const payload = commandMessageSchema.parse({
            schemaVersion: 2,
            commandId: command.commandId,
            deviceId: command.deviceId,
            type: command.type,
            timestamp: command.createdAt.toISOString(),
            expiresAt: command.expiresAt.toISOString(),
          });
          await transaction.insert(commandOutbox).values({
            commandId: command.commandId,
            topic: createCommandsTopic(command.deviceId),
            payload: JSON.stringify(payload),
            createdAt: command.createdAt,
            expiresAt: command.expiresAt,
            nextAttemptAt: command.createdAt,
          });
        }
        return {
          ...command,
          status: "PENDING",
          createdAt: command.createdAt.toISOString(),
          expiresAt: command.expiresAt?.toISOString(),
          sentAt: null,
        };
      });
    },
    async markSent(commandId, sentAt) {
      await database
        .update(commands)
        .set({ status: "SENT", sentAt })
        .where(
          and(
            eq(commands.commandId, commandId),
            eq(commands.status, "PENDING"),
          ),
        );
      return findCommand(commandId);
    },
    async markFailed(commandId) {
      await database
        .update(commands)
        .set({ status: "FAILED" })
        .where(
          and(
            eq(commands.commandId, commandId),
            eq(commands.status, "PENDING"),
          ),
        );
      return findCommand(commandId);
    },
    async history(deviceId, limit) {
      const registered = await database
        .select({ deviceId: devices.deviceId })
        .from(devices)
        .where(eq(devices.deviceId, deviceId))
        .limit(1);
      if (registered.length === 0) {
        return null;
      }
      const history = await database
        .select()
        .from(commands)
        .where(eq(commands.deviceId, deviceId))
        .orderBy(desc(commands.createdAt), desc(commands.commandId))
        .limit(limit);
      return history.map(toCommandHistoryItem);
    },
  };
}

function toCommandResponse(
  command: typeof commands.$inferSelect,
): CommandResponse {
  return {
    commandId: command.commandId,
    deviceId: command.deviceId,
    type: command.type,
    status: command.status,
    createdAt: command.createdAt.toISOString(),
    ...(command.expiresAt === null
      ? {}
      : { expiresAt: command.expiresAt.toISOString() }),
    sentAt: command.sentAt?.toISOString() ?? null,
  };
}

function toCommandHistoryItem(
  command: typeof commands.$inferSelect,
): CommandHistoryItem {
  return {
    ...toCommandResponse(command),
    ...(command.expiredAt === null
      ? {}
      : { expiredAt: command.expiredAt.toISOString() }),
    acknowledgementReceivedAt:
      command.acknowledgementReceivedAt?.toISOString() ?? null,
    timedOutAt: command.timedOutAt?.toISOString() ?? null,
  };
}

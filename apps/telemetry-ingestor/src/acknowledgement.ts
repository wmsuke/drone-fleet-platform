import { commands, type Database } from "@drone-fleet/database";
import {
  commandAcknowledgementMessageSchema,
  parseMqttTopic,
  type CommandAcknowledgementMessage,
} from "@drone-fleet/protocol";
import { and, eq, ne } from "drizzle-orm";

import type { IngestionLogger } from "./ingestion.js";

export type AcknowledgementResult = "updated" | "duplicate" | "not_found";

export interface CommandAcknowledgementRepository {
  acknowledge(
    message: CommandAcknowledgementMessage,
    receivedAt: Date,
  ): Promise<AcknowledgementResult>;
}

export function createCommandAcknowledgementRepository(
  database: Database,
): CommandAcknowledgementRepository {
  return {
    async acknowledge(message, receivedAt) {
      const updated = await database
        .update(commands)
        .set({
          status: "ACKNOWLEDGED",
          acknowledgementReceivedAt: receivedAt,
        })
        .where(
          and(
            eq(commands.commandId, message.commandId),
            eq(commands.deviceId, message.deviceId),
            ne(commands.status, "ACKNOWLEDGED"),
          ),
        )
        .returning({ commandId: commands.commandId });
      if (updated.length > 0) {
        return "updated";
      }

      const existing = await database
        .select({ commandId: commands.commandId })
        .from(commands)
        .where(
          and(
            eq(commands.commandId, message.commandId),
            eq(commands.deviceId, message.deviceId),
          ),
        )
        .limit(1);
      return existing.length > 0 ? "duplicate" : "not_found";
    },
  };
}

export async function ingestAcknowledgement(
  topic: string,
  payload: Buffer,
  receivedAt: Date,
  repository: CommandAcknowledgementRepository,
  logger: IngestionLogger,
): Promise<boolean> {
  const parsedTopic = parseMqttTopic(topic);
  let input: unknown;
  try {
    input = JSON.parse(payload.toString("utf8"));
  } catch {
    logger.warn("ACKを処理しませんでした", {
      reason: "本文が有効なJSONではありません",
      topic,
    });
    return false;
  }

  const parsed = commandAcknowledgementMessageSchema.safeParse(input);
  if (
    parsedTopic === null ||
    parsedTopic.kind !== "command-acks" ||
    !parsed.success ||
    parsed.data.deviceId !== parsedTopic.deviceId
  ) {
    logger.warn("ACKを処理しませんでした", {
      reason: "トピックまたは本文がACKの仕様に一致しません",
      topic,
    });
    return false;
  }

  try {
    const result = await repository.acknowledge(parsed.data, receivedAt);
    if (result === "not_found") {
      logger.warn("対応するコマンドがないACKを受信しました", {
        commandId: parsed.data.commandId,
        deviceId: parsed.data.deviceId,
        topic,
      });
      return false;
    }
    return true;
  } catch (error) {
    logger.error("ACKの保存に失敗しました", {
      commandId: parsed.data.commandId,
      deviceId: parsed.data.deviceId,
      error,
      topic,
    });
    return false;
  }
}

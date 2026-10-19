import {
  commands,
  commandExecutionEvents,
  appendAudit,
  commandAuditLinks,
  type Database,
} from "@drone-fleet/database";
import {
  commandAcknowledgementMessageSchema,
  parseMqttTopic,
  type CommandAcknowledgementMessage,
} from "@drone-fleet/protocol";
import { and, eq, isNull, isNotNull } from "drizzle-orm";

import type { IngestionLogger } from "./ingestion.js";

export type AcknowledgementResult =
  | "updated"
  | "duplicate"
  | "not_found"
  | "conflict";

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
      return database.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(commands)
          .where(
            and(
              eq(commands.commandId, message.commandId),
              eq(commands.deviceId, message.deviceId),
              message.schemaVersion >= 2
                ? isNotNull(commands.expiresAt)
                : isNull(commands.expiresAt),
            ),
          )
          .for("update");
        if (!row) return "not_found";
        const execution = !["ACKNOWLEDGED", "REJECTED_EXPIRED"].includes(
          message.status,
        );
        if (execution || message.status === "REJECTED_EXPIRED") {
          const startedAt =
            message.schemaVersion === 3 && message.startedAt
              ? new Date(message.startedAt)
              : null;
          const deviceTimestamp = new Date(message.timestamp);
          const [existing] = await tx
            .select()
            .from(commandExecutionEvents)
            .where(
              and(
                eq(commandExecutionEvents.commandId, row.commandId),
                eq(commandExecutionEvents.status, message.status),
                eq(commandExecutionEvents.deviceTimestamp, deviceTimestamp),
                startedAt
                  ? eq(commandExecutionEvents.startedAt, startedAt)
                  : isNull(commandExecutionEvents.startedAt),
              ),
            );
          if (existing)
            return existing.disposition === "conflict"
              ? "conflict"
              : "duplicate";
          let disposition: "applied" | "ignored" | "conflict" = "applied";
          if (execution) {
            if (
              !startedAt ||
              !row.expiresAt ||
              startedAt < row.createdAt ||
              startedAt >= row.expiresAt ||
              row.status === "EXPIRED" ||
              (row.executionStartedAt &&
                row.executionStartedAt.getTime() !== startedAt.getTime())
            )
              disposition = "conflict";
            else if (["SUCCEEDED", "FAILED"].includes(row.executionStatus)) {
              disposition = [
                "RUNNING",
                "UNCERTAIN",
                row.executionStatus,
              ].includes(message.status)
                ? "ignored"
                : "conflict";
            } else if (
              row.executionStatus === "UNCERTAIN" &&
              ["RUNNING", "UNCERTAIN"].includes(message.status)
            )
              disposition = "ignored";
            else if (
              row.executionStatus === "RUNNING" &&
              message.status === "RUNNING"
            )
              disposition = "ignored";
          } else if (row.executionStatus !== "NOT_REPORTED")
            disposition = "conflict";
          else if (row.status === "EXPIRED") disposition = "ignored";
          await tx.insert(commandExecutionEvents).values({
            commandId: row.commandId,
            deviceId: row.deviceId,
            status: message.status,
            startedAt,
            deviceTimestamp,
            receivedAt,
            disposition,
          });
          if (disposition === "conflict") {
            await appendAudit(tx, {
              action: "command.conflict",
              targetKind: "command",
              targetId: row.commandId,
              ...(await commandAuditLinks(tx, row.commandId)),
              system: "telemetry-ingestor",
              result: "REJECTED",
              metadata: {
                reason: "RESULT_CONFLICT",
                beforeStatus: row.executionStatus,
                afterStatus: message.status,
              },
            });
            return "conflict";
          }
          if (disposition === "ignored") return "duplicate";
          if (execution) {
            await tx
              .update(commands)
              .set({
                executionStatus: message.status,
                executionStartedAt: row.executionStartedAt ?? startedAt,
                executionStartedReceivedAt:
                  row.executionStartedReceivedAt ?? receivedAt,
                ...(message.status === "RUNNING"
                  ? {}
                  : {
                      executionResultAt: deviceTimestamp,
                      executionResultReceivedAt: receivedAt,
                    }),
              })
              .where(eq(commands.commandId, row.commandId));
          } else
            await tx
              .update(commands)
              .set({ status: "EXPIRED", expiredAt: receivedAt })
              .where(eq(commands.commandId, row.commandId));
          await appendAudit(tx, {
            action: execution ? "command.execution_changed" : "command.expired",
            targetKind: "command",
            targetId: row.commandId,
            ...(await commandAuditLinks(tx, row.commandId)),
            system: "telemetry-ingestor",
            metadata: {
              beforeStatus: execution ? row.executionStatus : row.status,
              afterStatus: execution ? message.status : "EXPIRED",
            },
          });
          return "updated";
        }
        if (
          row.acknowledgementReceivedAt !== null &&
          ["ACKNOWLEDGED", "EXPIRED"].includes(row.status)
        )
          return "duplicate";
        await tx
          .update(commands)
          .set({
            status: row.status === "EXPIRED" ? "EXPIRED" : "ACKNOWLEDGED",
            acknowledgementReceivedAt:
              row.acknowledgementReceivedAt ?? receivedAt,
          })
          .where(eq(commands.commandId, row.commandId));
        await appendAudit(tx, {
          action: "command.acknowledged",
          targetKind: "command",
          targetId: row.commandId,
          ...(await commandAuditLinks(tx, row.commandId)),
          system: "telemetry-ingestor",
          metadata: {
            beforeStatus: row.status,
            afterStatus: row.status === "EXPIRED" ? "EXPIRED" : "ACKNOWLEDGED",
          },
        });
        return "updated";
      });
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
    if (result === "conflict") {
      logger.warn("コマンド通知が保存済み状態と衝突しました", {
        commandId: parsed.data.commandId,
        deviceId: parsed.data.deviceId,
        status: parsed.data.status,
        topic,
      });
      return false;
    }
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

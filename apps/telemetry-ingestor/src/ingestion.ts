import {
  parseMqttTopic,
  telemetryMessageSchema,
  type TelemetryMessage,
} from "@drone-fleet/protocol";

import type { TelemetryPersistence } from "./batch-writer.js";
import type { LoadMetrics } from "./metrics.js";

export interface IngestionLogger {
  warn(message: string, context: Record<string, unknown>): void;
  error(message: string, context: Record<string, unknown>): void;
}

export type TelemetryParseResult =
  | { success: true; message: TelemetryMessage }
  | { success: false; reason: string };

export function parseTelemetry(
  topic: string,
  payload: Buffer,
): TelemetryParseResult {
  const parsedTopic = parseMqttTopic(topic);
  if (parsedTopic === null || parsedTopic.kind !== "telemetry") {
    return { success: false, reason: "テレメトリトピックの形式が不正です" };
  }

  let input: unknown;
  try {
    input = JSON.parse(payload.toString("utf8"));
  } catch {
    return { success: false, reason: "本文が有効なJSONではありません" };
  }

  const parsedMessage = telemetryMessageSchema.safeParse(input);
  if (!parsedMessage.success) {
    return {
      success: false,
      reason: "本文がテレメトリのスキーマに一致しません",
    };
  }

  if (parsedMessage.data.deviceId !== parsedTopic.deviceId) {
    return {
      success: false,
      reason: "トピックと本文のdeviceIdが一致しません",
    };
  }

  return { success: true, message: parsedMessage.data };
}

export async function ingestTelemetry(
  topic: string,
  payload: Buffer,
  receivedAt: Date,
  repository: TelemetryPersistence,
  logger: IngestionLogger,
  isRetained = false,
  metrics?: LoadMetrics,
  mqttReceivedAtMonotonic?: number,
): Promise<boolean> {
  const measurementStartedAt =
    metrics === undefined
      ? undefined
      : (mqttReceivedAtMonotonic ?? performance.now());
  const parsed = parseTelemetry(topic, payload);
  if (!parsed.success) {
    if (metrics?.recordMqttReceived(receivedAt) === true) {
      metrics.recordValidationFailure();
    }
    logger.warn("テレメトリを保存しませんでした", {
      reason: parsed.reason,
      topic,
    });
    return false;
  }

  const measured =
    metrics?.recordMqttReceived(new Date(parsed.message.timestamp)) ?? false;
  const measuredMetrics = measured ? metrics : undefined;
  measuredMetrics?.recordValidationSuccess(
    parsed.message.timestamp,
    receivedAt,
  );

  try {
    await repository.save(parsed.message, receivedAt, isRetained);
    if (measurementStartedAt !== undefined) {
      measuredMetrics?.recordDbSaveSuccess(
        performance.now() - measurementStartedAt,
      );
    }
    return true;
  } catch (error) {
    if (measurementStartedAt !== undefined) {
      measuredMetrics?.recordDbSaveFailure(
        performance.now() - measurementStartedAt,
      );
    }
    logger.error("テレメトリの保存に失敗しました", {
      deviceId: parsed.message.deviceId,
      error,
      topic,
    });
    return false;
  }
}

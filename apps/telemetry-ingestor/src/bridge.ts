import {
  bridgeEventMessageSchema,
  createBridgeReceiptsTopic,
  parseMqttTopic,
} from "@drone-fleet/protocol";
import type { BridgeRepository } from "@drone-fleet/database";
import type { IngestionLogger } from "./ingestion.js";

export async function ingestBridge(
  topic: string,
  body: Buffer,
  packet: { qos: number; retain?: boolean },
  receivedAt: Date,
  repository: BridgeRepository,
  publish: (topic: string, body: string) => Promise<unknown>,
  logger: IngestionLogger,
) {
  const parsed = parseMqttTopic(topic);
  if (
    !parsed ||
    parsed.kind !== "bridge-events" ||
    body.length > 32768 ||
    packet.qos !== 1 ||
    packet.retain
  )
    return;
  try {
    const result = bridgeEventMessageSchema.safeParse(
      JSON.parse(body.toString("utf8")),
    );
    if (!result.success || parsed.deviceId !== result.data.deviceId) {
      logger.warn("Bridge構成報告の形式が不正です", {});
      return;
    }
    const receipt = await repository.save(result.data, receivedAt);
    if (receipt)
      await publish(
        createBridgeReceiptsTopic(receipt.deviceId),
        JSON.stringify(receipt),
      );
    else
      logger.warn("Bridge eventの本文が衝突しました", {
        deviceId: parsed.deviceId,
      });
  } catch {
    logger.error("Bridge構成報告を保存・確認通知できませんでした", {
      deviceId: parsed.deviceId,
    });
  }
}

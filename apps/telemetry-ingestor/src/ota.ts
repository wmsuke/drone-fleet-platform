import {
  otaEventMessageSchema,
  otaInventoryMessageSchema,
  parseOtaMessage,
  createOtaReceiptsTopic,
} from "@drone-fleet/protocol";
import type { createOtaRepository } from "@drone-fleet/database";
import type { IngestionLogger } from "./ingestion.js";

export type OtaRepository = Pick<
  ReturnType<typeof createOtaRepository>,
  "ingest" | "inventory"
>;
export async function ingestOta(
  topic: string,
  payload: Buffer,
  packet: { qos: number; retain: boolean },
  receivedAt: Date,
  repository: OtaRepository,
  publish: (topic: string, payload: string) => Promise<unknown>,
  logger: IngestionLogger,
) {
  try {
    if (payload.length > 16384) throw new Error("OTA payload too large");
    const value: unknown = JSON.parse(payload.toString("utf8"));
    parseOtaMessage(topic, value, packet);
    const inventory = otaInventoryMessageSchema.safeParse(value);
    const receipt = inventory.success
      ? await repository.inventory(inventory.data, receivedAt)
      : await repository.ingest(otaEventMessageSchema.parse(value), receivedAt);
    // repositoryのtransactionがcommitしてからだけ送る。PUBACK喪失時は同event再送で回復する。
    if (receipt)
      await publish(
        createOtaReceiptsTopic(receipt.deviceId),
        JSON.stringify(receipt),
      );
  } catch {
    logger.error("OTA入力の検証・保存・receipt送信に失敗しました", {
      reason: "OTA_INGEST_FAILED",
    });
  }
}

import type { CommandAcknowledgementMessage } from "@drone-fleet/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  ingestAcknowledgement,
  type CommandAcknowledgementRepository,
} from "../src/acknowledgement.js";
import type { IngestionLogger } from "../src/ingestion.js";

const topic = "fleet/v1/devices/drone-001/command-acks";
const message = {
  schemaVersion: 1,
  commandId: "5c15de4f-6957-4f4f-b3cf-8cb9e733d63c",
  deviceId: "drone-001",
  status: "ACKNOWLEDGED",
  timestamp: "2026-09-30T02:00:01.000Z",
} satisfies CommandAcknowledgementMessage;

function dependencies(result: "updated" | "duplicate" | "not_found") {
  const repository: CommandAcknowledgementRepository = {
    acknowledge: vi.fn(async () => result),
  };
  const logger: IngestionLogger = { warn: vi.fn(), error: vi.fn() };
  return { logger, repository };
}

describe("ingestAcknowledgement", () => {
  it.each(["updated", "duplicate"] as const)(
    "safely handles a valid %s ACK",
    async (result) => {
      const { logger, repository } = dependencies(result);
      const receivedAt = new Date("2026-09-30T02:00:02.000Z");

      await expect(
        ingestAcknowledgement(
          topic,
          Buffer.from(JSON.stringify(message)),
          receivedAt,
          repository,
          logger,
        ),
      ).resolves.toBe(true);
      expect(repository.acknowledge).toHaveBeenCalledWith(message, receivedAt);
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );

  it("logs an ACK for an unknown command without updating state", async () => {
    const { logger, repository } = dependencies("not_found");

    await expect(
      ingestAcknowledgement(
        topic,
        Buffer.from(JSON.stringify(message)),
        new Date(),
        repository,
        logger,
      ),
    ).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      "対応するコマンドがないACKを受信しました",
      expect.objectContaining({ commandId: message.commandId }),
    );
  });

  it.each([
    ["invalid JSON", topic, Buffer.from("{")],
    [
      "invalid schema",
      topic,
      Buffer.from(JSON.stringify({ ...message, status: "COMPLETED" })),
    ],
    [
      "device ID mismatch",
      topic,
      Buffer.from(JSON.stringify({ ...message, deviceId: "drone-002" })),
    ],
  ])("rejects %s", async (_name, receivedTopic, payload) => {
    const { logger, repository } = dependencies("updated");

    await expect(
      ingestAcknowledgement(
        receivedTopic,
        payload,
        new Date(),
        repository,
        logger,
      ),
    ).resolves.toBe(false);
    expect(repository.acknowledge).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});

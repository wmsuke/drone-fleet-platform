import type { ConnectionStatusMessage } from "@drone-fleet/protocol";
import { describe, expect, it, vi } from "vitest";

import type { IngestionLogger } from "../src/ingestion.js";
import { ingestStatus, type DeviceStatusRepository } from "../src/status.js";
import { createLoadMetrics } from "../src/metrics.js";

const topic = "fleet/v1/devices/drone-001/status";
const message = {
  schemaVersion: 1,
  deviceId: "drone-001",
  timestamp: "2026-09-29T02:00:00.000Z",
  payload: { status: "ONLINE", reason: "CONNECTED" },
} satisfies ConnectionStatusMessage;

function createDependencies() {
  const saved: Array<{
    message: ConnectionStatusMessage;
    receivedAt: Date;
    isRetained: boolean;
  }> = [];
  const repository: DeviceStatusRepository = {
    async saveStatus(savedMessage, receivedAt, isRetained) {
      saved.push({ message: savedMessage, receivedAt, isRetained });
      return 0;
    },
    async markTimedOut() {
      return 0;
    },
  };
  const logger: IngestionLogger = { warn: vi.fn(), error: vi.fn() };
  return { logger, repository, saved };
}

describe("ingestStatus", () => {
  it("saves a valid status with receipt and retained metadata", async () => {
    const { logger, repository, saved } = createDependencies();
    const receivedAt = new Date("2026-09-29T02:00:01.000Z");

    await expect(
      ingestStatus(
        topic,
        Buffer.from(JSON.stringify(message)),
        receivedAt,
        true,
        repository,
        logger,
      ),
    ).resolves.toBe(true);
    expect(saved).toEqual([{ message, receivedAt, isRetained: true }]);
  });

  it.each([
    ["invalid JSON", topic, Buffer.from("{")],
    [
      "invalid topic",
      "fleet/v1/devices/drone-001/telemetry",
      Buffer.from(JSON.stringify(message)),
    ],
    [
      "device ID mismatch",
      topic,
      Buffer.from(JSON.stringify({ ...message, deviceId: "drone-002" })),
    ],
  ])("rejects %s", async (_name, receivedTopic, payload) => {
    const { logger, repository, saved } = createDependencies();

    await expect(
      ingestStatus(
        receivedTopic,
        payload,
        new Date(),
        false,
        repository,
        logger,
      ),
    ).resolves.toBe(false);
    expect(saved).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("records only transitions reported by the repository", async () => {
    const metrics = createLoadMetrics({
      testId: "test-1",
      sessionId: "ingestor-a",
      reportPath: "/tmp/metrics.json",
    });
    const repository: DeviceStatusRepository = {
      saveStatus: vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0),
      markTimedOut: vi.fn(async () => 0),
    };
    const logger: IngestionLogger = { warn: vi.fn(), error: vi.fn() };
    const offlineMessage: ConnectionStatusMessage = {
      ...message,
      payload: { status: "OFFLINE", reason: "CONNECTION_LOST" },
    };
    const offlinePayload = Buffer.from(JSON.stringify(offlineMessage));

    await ingestStatus(
      topic,
      offlinePayload,
      new Date(),
      false,
      repository,
      logger,
      metrics,
    );
    await ingestStatus(
      topic,
      offlinePayload,
      new Date(),
      false,
      repository,
      logger,
      metrics,
    );

    expect(metrics.snapshot().counters.offlineTransitions).toBe(1);
  });
});

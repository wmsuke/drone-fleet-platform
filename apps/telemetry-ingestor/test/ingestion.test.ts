import type { TelemetryMessage } from "@drone-fleet/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  ingestTelemetry,
  parseTelemetry,
  type IngestionLogger,
} from "../src/ingestion.js";
import type { TelemetryPersistence } from "../src/batch-writer.js";
import { createLoadMetrics } from "../src/metrics.js";

const topic = "fleet/v1/devices/drone-001/telemetry";
const message = {
  schemaVersion: 1,
  deviceId: "drone-001",
  sequence: 12,
  timestamp: "2026-09-29T02:00:00.000Z",
  payload: {
    battery: 80,
    latitude: 35.681236,
    longitude: 139.767125,
    altitude: 20,
    temperature: 25,
    status: "FLYING",
  },
} satisfies TelemetryMessage;
const v2Message = {
  ...message,
  schemaVersion: 2,
  sessionId: "a065e32b-c00b-452e-9cb1-3b52c43962fb",
} satisfies TelemetryMessage;

function payload(input: unknown = message): Buffer {
  return Buffer.from(JSON.stringify(input));
}

function createDependencies() {
  const saved: Array<{ message: TelemetryMessage; receivedAt: Date }> = [];
  const repository: TelemetryPersistence = {
    async save(savedMessage, receivedAt) {
      saved.push({ message: savedMessage, receivedAt });
    },
  };
  const logger: IngestionLogger = {
    warn: vi.fn(),
    error: vi.fn(),
  };
  return { logger, repository, saved };
}

describe("parseTelemetry", () => {
  it("accepts valid telemetry whose device ID matches the topic", () => {
    expect(parseTelemetry(topic, payload())).toEqual({
      success: true,
      message,
    });
  });

  it("accepts v2 telemetry on the unchanged topic", () => {
    expect(parseTelemetry(topic, payload(v2Message))).toEqual({
      success: true,
      message: v2Message,
    });
  });

  it.each([
    ["missing", { ...v2Message, sessionId: undefined }],
    ["malformed", { ...v2Message, sessionId: "not-a-uuid" }],
    ["overlong", { ...v2Message, sessionId: `${v2Message.sessionId}0` }],
  ])("rejects v2 telemetry with %s sessionId", (_case, input) => {
    expect(parseTelemetry(topic, payload(input)).success).toBe(false);
  });

  it.each([
    ["invalid topic", "fleet/v1/devices/drone-001/status", payload()],
    ["invalid JSON", topic, Buffer.from("{")],
    ["invalid schema", topic, payload({ ...message, sequence: -1 })],
    [
      "device ID mismatch",
      topic,
      payload({ ...message, deviceId: "drone-002" }),
    ],
  ])("rejects %s", (_name, receivedTopic, receivedPayload) => {
    expect(parseTelemetry(receivedTopic, receivedPayload).success).toBe(false);
  });
});

describe("ingestTelemetry", () => {
  it("sends receipts only after save completes, including duplicates but not conflicts or failures", async () => {
    const { logger } = createDependencies();
    const publishReceipt = vi.fn(async () => undefined);
    let complete!: (outcome: "saved") => void;
    const repository: TelemetryPersistence = {
      save: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    };
    const task = ingestTelemetry(
      topic,
      payload(v2Message),
      new Date(),
      repository,
      logger,
      false,
      undefined,
      undefined,
      publishReceipt,
    );
    expect(publishReceipt).not.toHaveBeenCalled();
    complete("saved");
    await task;
    expect(publishReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "STORED",
        deviceId: v2Message.deviceId,
        sessionId: v2Message.sessionId,
        sequence: v2Message.sequence,
      }),
    );
    await ingestTelemetry(
      topic,
      payload(v2Message),
      new Date(),
      { save: async () => "duplicate" },
      logger,
      false,
      undefined,
      undefined,
      publishReceipt,
    );
    expect(publishReceipt).toHaveBeenCalledTimes(2);
    for (const save of [
      async () => "conflict" as const,
      async () => {
        throw new Error("DB unavailable");
      },
    ]) {
      await ingestTelemetry(
        topic,
        payload(v2Message),
        new Date(),
        { save },
        logger,
        false,
        undefined,
        undefined,
        publishReceipt,
      );
    }
    await ingestTelemetry(
      topic,
      payload(message),
      new Date(),
      { save: async () => "saved" },
      logger,
      false,
      undefined,
      undefined,
      publishReceipt,
    );
    expect(publishReceipt).toHaveBeenCalledTimes(2);
  });

  it("keeps the committed save successful when receipt publication fails", async () => {
    const { logger } = createDependencies();
    expect(
      await ingestTelemetry(
        topic,
        payload(v2Message),
        new Date(),
        { save: async () => "saved" },
        logger,
        false,
        undefined,
        undefined,
        async () => {
          throw new Error("receipt lost");
        },
      ),
    ).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      "テレメトリの保存確認通知に失敗しました",
      expect.anything(),
    );
  });
  it("counts identical replays as successful and content conflicts separately", async () => {
    const { logger } = createDependencies();
    const metrics = createLoadMetrics({
      testId: "dedup",
      sessionId: "ingestor",
      reportPath: "unused.json",
    });
    const receivedAt = new Date(v2Message.timestamp);
    const repository: TelemetryPersistence = {
      save: vi
        .fn()
        .mockResolvedValueOnce("duplicate")
        .mockResolvedValueOnce("conflict"),
    };
    expect(
      await ingestTelemetry(
        topic,
        payload(v2Message),
        receivedAt,
        repository,
        logger,
        false,
        metrics,
      ),
    ).toBe(true);
    expect(
      await ingestTelemetry(
        topic,
        payload(v2Message),
        receivedAt,
        repository,
        logger,
        false,
        metrics,
      ),
    ).toBe(false);
    expect(metrics.snapshot().counters).toMatchObject({
      dbSaveSucceeded: 1,
      dbSaveFailed: 0,
      dbInserted: 0,
      telemetryDuplicates: 1,
      telemetryConflicts: 1,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "テレメトリの識別子と内容が衝突しました",
      expect.objectContaining({
        deviceId: v2Message.deviceId,
        sessionId: v2Message.sessionId,
        sequence: v2Message.sequence,
      }),
    );
  });
  it("saves valid telemetry with the server receipt time", async () => {
    const { logger, repository, saved } = createDependencies();
    const receivedAt = new Date("2026-09-29T02:00:01.000Z");

    await expect(
      ingestTelemetry(topic, payload(), receivedAt, repository, logger),
    ).resolves.toBe(true);
    expect(saved).toEqual([{ message, receivedAt }]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("passes the validated v2 session ID into persistence", async () => {
    const { logger, repository, saved } = createDependencies();
    const receivedAt = new Date("2026-09-29T02:00:01.000Z");

    await expect(
      ingestTelemetry(
        topic,
        payload(v2Message),
        receivedAt,
        repository,
        logger,
      ),
    ).resolves.toBe(true);
    expect(saved).toEqual([{ message: v2Message, receivedAt }]);
  });

  it("continues with the next message after invalid input", async () => {
    const { logger, repository, saved } = createDependencies();
    const receivedAt = new Date("2026-09-29T02:00:01.000Z");

    await expect(
      ingestTelemetry(topic, Buffer.from("{"), receivedAt, repository, logger),
    ).resolves.toBe(false);
    await expect(
      ingestTelemetry(topic, payload(), receivedAt, repository, logger),
    ).resolves.toBe(true);

    expect(saved).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "テレメトリを保存しませんでした",
      expect.objectContaining({
        reason: "本文が有効なJSONではありません",
        topic,
      }),
    );
  });

  it("logs a save error without rejecting the receive loop", async () => {
    const logger: IngestionLogger = { warn: vi.fn(), error: vi.fn() };
    const repository: TelemetryPersistence = {
      async save() {
        throw new Error("database unavailable");
      },
    };

    await expect(
      ingestTelemetry(topic, payload(), new Date(), repository, logger),
    ).resolves.toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      "テレメトリの保存に失敗しました",
      expect.objectContaining({ deviceId: "drone-001", topic }),
    );
  });

  it("records validation and DB persistence outcomes separately", async () => {
    const monotonicNow = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(140)
      .mockReturnValueOnce(260);
    const metrics = createLoadMetrics(
      {
        testId: "test-1",
        sessionId: "ingestor-a",
        reportPath: "/tmp/metrics.json",
      },
      { now: () => new Date("2026-09-29T02:00:02.000Z") },
    );
    const logger: IngestionLogger = { warn: vi.fn(), error: vi.fn() };
    const repository: TelemetryPersistence = {
      save: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("database unavailable")),
    };
    const receivedAt = new Date("2026-09-29T02:00:01.000Z");

    await ingestTelemetry(
      topic,
      Buffer.from("{"),
      receivedAt,
      repository,
      logger,
      false,
      metrics,
      0,
    );
    await ingestTelemetry(
      topic,
      payload(),
      receivedAt,
      repository,
      logger,
      false,
      metrics,
      100,
    );
    await ingestTelemetry(
      topic,
      payload({ ...message, sequence: 13 }),
      receivedAt,
      repository,
      logger,
      false,
      metrics,
      200,
    );

    const report = metrics.snapshot();
    expect(report.counters).toMatchObject({
      validationSucceeded: 2,
      validationFailed: 1,
      dbSaveSucceeded: 1,
      dbSaveFailed: 1,
    });
    expect(report.timings.deviceTimestampToMqttReceiveMs).toMatchObject({
      count: 2,
      minMs: 1000,
      maxMs: 1000,
    });
    expect(report.timings.mqttReceiveToDbCompleteMs).toMatchObject({
      count: 2,
      minMs: 40,
      maxMs: 60,
      sumMs: 100,
    });
    expect(monotonicNow).toHaveBeenCalledTimes(2);
    monotonicNow.mockRestore();
  });
});

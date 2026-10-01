import type { IClientOptions, IPublishPacket } from "mqtt";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CommandAcknowledgementRepository } from "../src/acknowledgement.js";
import {
  COMMAND_ACK_TOPIC_FILTER,
  startTelemetryIngestor,
  STATUS_TOPIC_FILTER,
  TELEMETRY_TOPIC_FILTER,
  type TelemetryMqttClient,
} from "../src/app.js";
import type { IngestionLogger } from "../src/ingestion.js";
import type { TelemetryRepository } from "../src/repository.js";
import type { DeviceStatusRepository } from "../src/status.js";
import { createLoadMetrics } from "../src/metrics.js";

class FakeMqttClient implements TelemetryMqttClient {
  readonly endForces: Array<boolean | undefined> = [];
  readonly subscriptions: Array<{ topic: string; options: { qos: 0 | 1 } }> =
    [];
  private readonly messageListeners: Array<
    (topic: string, payload: Buffer, packet: IPublishPacket) => void
  > = [];

  async endAsync(force?: boolean): Promise<void> {
    this.endForces.push(force);
  }

  on(
    event: "message",
    listener: (topic: string, payload: Buffer, packet: IPublishPacket) => void,
  ): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: string, listener: (...args: never[]) => void): this {
    if (event === "message") {
      this.messageListeners.push(listener);
    }
    return this;
  }

  async subscribeAsync(topic: string, options: { qos: 0 | 1 }): Promise<void> {
    this.subscriptions.push({ topic, options });
  }

  emitMessage(topic: string, payload: Buffer, retain = false): void {
    for (const listener of this.messageListeners) {
      listener(topic, payload, { retain } as IPublishPacket);
    }
  }
}

function validTelemetryPayload(): Buffer {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      deviceId: "drone-001",
      sequence: 0,
      timestamp: "2026-09-29T02:00:00.000Z",
      payload: {
        battery: 100,
        latitude: 35,
        longitude: 139,
        altitude: 0,
        temperature: 25,
        status: "IDLE",
      },
    }),
  );
}

function acknowledgementRepository(): CommandAcknowledgementRepository {
  return { acknowledge: vi.fn(async () => "updated") };
}

describe("startTelemetryIngestor", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("subscribes to all telemetry topics and handles consecutive messages", async () => {
    const client = new FakeMqttClient();
    let connection: { url: string; options: IClientOptions } | undefined;
    const saved: string[] = [];
    const repository: TelemetryRepository = {
      async save(message) {
        saved.push(message.deviceId);
      },
    };
    const logger: IngestionLogger = { warn: vi.fn(), error: vi.fn() };
    const statusRepository: DeviceStatusRepository = {
      saveStatus: vi.fn(async () => 0),
      markTimedOut: vi.fn(async () => 0),
    };
    const ackRepository = acknowledgementRepository();
    const ingestor = await startTelemetryIngestor(
      { mqttUrl: "mqtt://127.0.0.1:1883", offlineTimeoutMs: 15_000 },
      repository,
      statusRepository,
      ackRepository,
      logger,
      async (url, options) => {
        connection = { url, options };
        return client;
      },
    );

    expect(connection).toEqual({
      url: "mqtt://127.0.0.1:1883",
      options: { clean: true, clientId: "telemetry-ingestor" },
    });
    expect(client.subscriptions).toEqual([
      { topic: TELEMETRY_TOPIC_FILTER, options: { qos: 0 } },
      { topic: STATUS_TOPIC_FILTER, options: { qos: 1 } },
      { topic: COMMAND_ACK_TOPIC_FILTER, options: { qos: 1 } },
    ]);

    client.emitMessage(TELEMETRY_TOPIC_FILTER, Buffer.from("{"));
    client.emitMessage(
      "fleet/v1/devices/drone-001/telemetry",
      validTelemetryPayload(),
    );
    await vi.waitFor(() => expect(saved).toEqual(["drone-001"]));

    client.emitMessage(
      "fleet/v1/devices/drone-001/command-acks",
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          commandId: "5c15de4f-6957-4f4f-b3cf-8cb9e733d63c",
          deviceId: "drone-001",
          status: "ACKNOWLEDGED",
          timestamp: "2026-09-29T02:00:01.000Z",
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(ackRepository.acknowledge).toHaveBeenCalledOnce(),
    );

    await ingestor.shutdown();
    expect(client.endForces).toEqual([false]);
  });

  it("waits for in-flight persistence before shutdown completes", async () => {
    const client = new FakeMqttClient();
    let releaseSave = (): void => undefined;
    let markSaveStarted = (): void => undefined;
    const saveStarted = new Promise<void>((resolve) => {
      markSaveStarted = resolve;
    });
    const saveBlocker = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const repository: TelemetryRepository = {
      async save() {
        markSaveStarted();
        await saveBlocker;
      },
    };
    const logger: IngestionLogger = { warn: vi.fn(), error: vi.fn() };
    const statusRepository: DeviceStatusRepository = {
      saveStatus: vi.fn(async () => 0),
      markTimedOut: vi.fn(async () => 0),
    };
    const ingestor = await startTelemetryIngestor(
      { mqttUrl: "mqtt://127.0.0.1:1883", offlineTimeoutMs: 15_000 },
      repository,
      statusRepository,
      acknowledgementRepository(),
      logger,
      async () => client,
    );

    client.emitMessage(
      "fleet/v1/devices/drone-001/telemetry",
      validTelemetryPayload(),
    );
    await saveStarted;

    let shutdownCompleted = false;
    const shutdown = ingestor.shutdown().then(() => {
      shutdownCompleted = true;
    });

    await vi.waitFor(() => expect(client.endForces).toEqual([false]));
    await Promise.resolve();
    expect(shutdownCompleted).toBe(false);

    releaseSave();
    await shutdown;
    expect(shutdownCompleted).toBe(true);
  });

  it("marks devices offline after the configured receipt timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T02:00:15.000Z"));
    const client = new FakeMqttClient();
    const repository: TelemetryRepository = { save: vi.fn() };
    const statusRepository: DeviceStatusRepository = {
      saveStatus: vi.fn(async () => 0),
      markTimedOut: vi.fn(async () => 0),
    };
    const logger: IngestionLogger = { warn: vi.fn(), error: vi.fn() };
    const ingestor = await startTelemetryIngestor(
      { mqttUrl: "mqtt://127.0.0.1:1883", offlineTimeoutMs: 15_000 },
      repository,
      statusRepository,
      acknowledgementRepository(),
      logger,
      async () => client,
    );

    await vi.advanceTimersByTimeAsync(1_000);

    expect(statusRepository.markTimedOut).toHaveBeenCalledWith(
      new Date("2026-09-29T02:00:01.000Z"),
      new Date("2026-09-29T02:00:16.000Z"),
    );
    await ingestor.shutdown();
  });

  it("measures DB completion from the MQTT receipt before validation", async () => {
    const monotonicNow = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(150)
      .mockReturnValueOnce(180);
    const client = new FakeMqttClient();
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const metrics = createLoadMetrics(
      {
        testId: "test-1",
        sessionId: "ingestor-a",
        reportPath: "/tmp/metrics.json",
      },
      { writeFile },
    );
    const repository: TelemetryRepository = { save: vi.fn() };
    const statusRepository: DeviceStatusRepository = {
      saveStatus: vi.fn(async () => 0),
      markTimedOut: vi.fn(async () => 0),
    };
    const ingestor = await startTelemetryIngestor(
      { mqttUrl: "mqtt://127.0.0.1:1883", offlineTimeoutMs: 15_000 },
      repository,
      statusRepository,
      acknowledgementRepository(),
      { warn: vi.fn(), error: vi.fn() },
      async () => client,
      metrics,
    );

    client.emitMessage(
      "fleet/v1/devices/drone-001/telemetry",
      Buffer.from("{"),
    );
    client.emitMessage(
      "fleet/v1/devices/drone-001/telemetry",
      validTelemetryPayload(),
    );
    await ingestor.shutdown();

    const report = metrics.snapshot();
    expect(report.counters).toMatchObject({
      mqttReceived: 2,
      validationSucceeded: 1,
      validationFailed: 1,
      dbSaveSucceeded: 1,
      dbSaveFailed: 0,
    });
    expect(report.timings.mqttReceiveToDbCompleteMs).toMatchObject({
      count: 1,
      minMs: 30,
      maxMs: 30,
    });
    expect(monotonicNow).toHaveBeenCalledTimes(3);
    expect(writeFile).toHaveBeenCalledOnce();
  });
});

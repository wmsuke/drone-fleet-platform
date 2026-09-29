import type { IClientOptions } from "mqtt";
import { describe, expect, it, vi } from "vitest";

import {
  startTelemetryIngestor,
  TELEMETRY_TOPIC_FILTER,
  type TelemetryMqttClient,
} from "../src/app.js";
import type { IngestionLogger } from "../src/ingestion.js";
import type { TelemetryRepository } from "../src/repository.js";

class FakeMqttClient implements TelemetryMqttClient {
  readonly endForces: Array<boolean | undefined> = [];
  readonly subscriptions: Array<{ topic: string; options: { qos: 0 } }> = [];
  private readonly messageListeners: Array<
    (topic: string, payload: Buffer) => void
  > = [];

  async endAsync(force?: boolean): Promise<void> {
    this.endForces.push(force);
  }

  on(
    event: "message",
    listener: (topic: string, payload: Buffer) => void,
  ): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: string, listener: (...args: never[]) => void): this {
    if (event === "message") {
      this.messageListeners.push(listener);
    }
    return this;
  }

  async subscribeAsync(topic: string, options: { qos: 0 }): Promise<void> {
    this.subscriptions.push({ topic, options });
  }

  emitMessage(topic: string, payload: Buffer): void {
    for (const listener of this.messageListeners) {
      listener(topic, payload);
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

describe("startTelemetryIngestor", () => {
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
    const ingestor = await startTelemetryIngestor(
      { mqttUrl: "mqtt://127.0.0.1:1883" },
      repository,
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
    ]);

    client.emitMessage(TELEMETRY_TOPIC_FILTER, Buffer.from("{"));
    client.emitMessage(
      "fleet/v1/devices/drone-001/telemetry",
      validTelemetryPayload(),
    );
    await vi.waitFor(() => expect(saved).toEqual(["drone-001"]));

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
    const ingestor = await startTelemetryIngestor(
      { mqttUrl: "mqtt://127.0.0.1:1883" },
      repository,
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
});

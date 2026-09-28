import {
  connectionStatusMessageSchema,
  telemetryMessageSchema,
} from "@drone-fleet/protocol";
import type { IClientOptions } from "mqtt";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  startSimulator,
  type ConnectSimulatorClient,
  type SimulatorMqttClient,
} from "../src/simulator.js";

interface PublishedMessage {
  topic: string;
  message: string;
  options: { qos: 0 | 1; retain: boolean };
}

class FakeMqttClient implements SimulatorMqttClient {
  connected = true;
  readonly published: PublishedMessage[] = [];
  readonly endForces: Array<boolean | undefined> = [];
  private readonly listeners = new Map<
    string,
    Array<(...args: never[]) => void>
  >();

  async publishAsync(
    topic: string,
    message: string,
    options: { qos: 0 | 1; retain: boolean },
  ): Promise<void> {
    this.published.push({ topic, message, options });
  }

  async endAsync(force?: boolean): Promise<void> {
    this.endForces.push(force);
    this.connected = false;
  }

  on(event: "connect" | "offline", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: string, listener: (...args: never[]) => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("startSimulator", () => {
  it("publishes LWT, ONLINE, telemetry, and OFFLINE before disconnecting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T08:00:00.000Z"));
    const client = new FakeMqttClient();
    let connectionOptions: IClientOptions | undefined;
    const connectClient: ConnectSimulatorClient = async (_url, options) => {
      connectionOptions = options;
      return client;
    };

    const simulator = await startSimulator(
      {
        deviceId: "drone-001",
        mqttUrl: "mqtt://127.0.0.1:1883",
        telemetryIntervalMs: 5000,
      },
      connectClient,
    );

    const lwt = connectionStatusMessageSchema.parse(
      JSON.parse(connectionOptions?.will?.payload.toString() ?? ""),
    );
    expect(connectionOptions?.will).toMatchObject({
      topic: "fleet/v1/devices/drone-001/status",
      qos: 1,
      retain: true,
    });
    expect(lwt.payload).toEqual({
      status: "OFFLINE",
      reason: "CONNECTION_LOST",
    });

    expect(client.published).toHaveLength(2);
    const online = connectionStatusMessageSchema.parse(
      JSON.parse(client.published[0]?.message ?? ""),
    );
    const firstTelemetry = telemetryMessageSchema.parse(
      JSON.parse(client.published[1]?.message ?? ""),
    );
    expect(online.payload).toEqual({ status: "ONLINE", reason: "CONNECTED" });
    expect(firstTelemetry.sequence).toBe(0);

    await vi.advanceTimersByTimeAsync(5000);
    const secondTelemetry = telemetryMessageSchema.parse(
      JSON.parse(client.published[2]?.message ?? ""),
    );
    expect(secondTelemetry.sequence).toBe(1);

    await simulator.shutdown();

    const offline = connectionStatusMessageSchema.parse(
      JSON.parse(client.published[3]?.message ?? ""),
    );
    expect(offline.payload).toEqual({ status: "OFFLINE", reason: "SHUTDOWN" });
    expect(client.published[3]?.options).toEqual({ qos: 1, retain: true });
    expect(client.endForces).toEqual([false]);
  });

  it("forces shutdown without publishing when disconnected", async () => {
    vi.useFakeTimers();
    const client = new FakeMqttClient();
    const simulator = await startSimulator(
      {
        deviceId: "drone-001",
        mqttUrl: "mqtt://127.0.0.1:1883",
        telemetryIntervalMs: 5000,
      },
      async () => client,
    );
    client.connected = false;

    await simulator.shutdown();

    expect(client.published).toHaveLength(2);
    expect(client.endForces).toEqual([true]);
  });
});

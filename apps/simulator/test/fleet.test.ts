import { telemetryMessageSchema } from "@drone-fleet/protocol";
import type { IClientOptions } from "mqtt";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDeviceId, startSimulatorFleet } from "../src/fleet.js";
import type {
  ConnectSimulatorClient,
  SimulatorMqttClient,
} from "../src/simulator.js";

interface PublishedMessage {
  topic: string;
  message: string;
}

class FakeMqttClient implements SimulatorMqttClient {
  connected = true;
  options: IClientOptions = {};
  readonly published: PublishedMessage[] = [];
  readonly endForces: Array<boolean | undefined> = [];

  async publishAsync(topic: string, message: string): Promise<void> {
    this.published.push({ topic, message });
  }

  async subscribeAsync(): Promise<void> {}

  async endAsync(force?: boolean): Promise<void> {
    this.endForces.push(force);
    this.connected = false;
  }

  reconnect(): this {
    return this;
  }

  on(): this {
    return this;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createDeviceId", () => {
  it.each([
    [1, "drone-001"],
    [10, "drone-010"],
    [1000, "drone-1000"],
  ])("creates a device ID for index %i", (index, expected) => {
    expect(createDeviceId(index)).toBe(expected);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid index %s",
    (index) => {
      expect(() => createDeviceId(index)).toThrow(TypeError);
    },
  );
});

describe("startSimulatorFleet", () => {
  it("starts ten identifiable clients and shuts all of them down", async () => {
    vi.useFakeTimers();
    const clients: FakeMqttClient[] = [];
    const clientIds: string[] = [];
    const connectClient: ConnectSimulatorClient = async (_url, options) => {
      const client = new FakeMqttClient();
      client.options = options;
      clients.push(client);
      clientIds.push(options.clientId ?? "");
      return client;
    };

    const fleet = await startSimulatorFleet(
      {
        droneCount: 10,
        mqttUrl: "mqtt://127.0.0.1:1883",
        telemetryIntervalMs: 5000,
      },
      connectClient,
    );

    expect(clientIds).toEqual(
      Array.from(
        { length: 10 },
        (_, index) => `simulator-${createDeviceId(index + 1)}`,
      ),
    );
    const telemetry = clients.map((client) => {
      const published = client.published.find(({ topic }) =>
        topic.endsWith("/telemetry"),
      );
      return {
        topic: published?.topic,
        message: telemetryMessageSchema.parse(
          JSON.parse(published?.message ?? ""),
        ),
      };
    });
    expect(telemetry.map(({ topic }) => topic)).toEqual(
      Array.from(
        { length: 10 },
        (_, index) => `fleet/v1/devices/${createDeviceId(index + 1)}/telemetry`,
      ),
    );
    expect(telemetry.map(({ message }) => message.deviceId)).toEqual(
      Array.from({ length: 10 }, (_, index) => createDeviceId(index + 1)),
    );

    await fleet.shutdown();

    expect(clients.every((client) => client.endForces[0] === false)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shuts down already started clients when startup fails", async () => {
    vi.useFakeTimers();
    const firstClient = new FakeMqttClient();
    let connectionAttempt = 0;
    const connectClient: ConnectSimulatorClient = async () => {
      connectionAttempt += 1;
      if (connectionAttempt === 2) {
        throw new Error("connection failed");
      }
      return firstClient;
    };

    await expect(
      startSimulatorFleet(
        {
          droneCount: 2,
          mqttUrl: "mqtt://127.0.0.1:1883",
          telemetryIntervalMs: 5000,
        },
        connectClient,
      ),
    ).rejects.toThrow("connection failed");
    expect(firstClient.endForces).toEqual([false]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

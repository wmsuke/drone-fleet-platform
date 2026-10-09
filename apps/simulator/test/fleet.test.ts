import { telemetryMessageSchema } from "@drone-fleet/protocol";
import type { IClientOptions } from "mqtt";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { createDeviceId, startSimulatorFleet } from "../src/fleet.js";
import type {
  ConnectSimulatorClient,
  SimulatorMqttClient,
} from "../src/simulator.js";

interface PublishedMessage {
  topic: string;
  message: string;
}

const bufferRoot = mkdtempSync(join(tmpdir(), "drone-fleet-fleet-test-"));
let bufferNumber = 0;
function bufferSettings() {
  return {
    telemetryBufferDirectory: join(bufferRoot, String(++bufferNumber)),
    telemetryBufferMaxRows: 10_000,
    telemetryBufferMaxBytes: 32 * 1024 * 1024,
  };
}

afterAll(() => rmSync(bufferRoot, { recursive: true, force: true }));

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

  it("uses the configured device ID prefix", () => {
    expect(createDeviceId(1, "dev-drone")).toBe("dev-drone-001");
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
        deviceIdPrefix: "drone",
        droneCount: 10,
        mqttTransport: { type: "local", url: "mqtt://127.0.0.1:1883" },
        simulationSeed: "fleet-test",
        telemetryIntervalMs: 5000,
        ...bufferSettings(),
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
    expect(fleet.getBufferStatuses()["drone-001"]).toMatchObject({
      rows: 1,
      backlog: 1,
      healthy: true,
    });

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
          deviceIdPrefix: "drone",
          droneCount: 2,
          mqttTransport: { type: "local", url: "mqtt://127.0.0.1:1883" },
          simulationSeed: "fleet-test",
          telemetryIntervalMs: 5000,
          ...bufferSettings(),
        },
        connectClient,
      ),
    ).rejects.toThrow("connection failed");
    expect(firstClient.endForces).toEqual([false]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts AWS devices with distinct client IDs and credentials", async () => {
    vi.useFakeTimers();
    const clients: FakeMqttClient[] = [];
    const connectionOptions: IClientOptions[] = [];
    const connectClient: ConnectSimulatorClient = async (_url, options) => {
      const client = new FakeMqttClient();
      client.options = options;
      clients.push(client);
      connectionOptions.push(options);
      return client;
    };

    const fleet = await startSimulatorFleet(
      {
        deviceIdPrefix: "dev-drone",
        droneCount: 2,
        mqttTransport: {
          type: "aws-iot",
          endpoint: "example.iot",
          rootCaPath: "/ca",
          deviceCredentialsDirectory: "/devices",
        },
        simulationSeed: "fleet-test",
        telemetryIntervalMs: 5000,
        ...bufferSettings(),
      },
      connectClient,
      async (deviceId) => ({
        url: "mqtts://example.iot:8883",
        clientOptions: {
          ca: Buffer.from("ca"),
          cert: Buffer.from(`cert-${deviceId}`),
          clientId: deviceId,
          key: Buffer.from(`key-${deviceId}`),
          rejectUnauthorized: true,
        },
      }),
    );

    expect(connectionOptions.map(({ clientId }) => clientId)).toEqual([
      "dev-drone-001",
      "dev-drone-002",
    ]);
    expect(connectionOptions.map(({ cert }) => cert?.toString())).toEqual([
      "cert-dev-drone-001",
      "cert-dev-drone-002",
    ]);
    expect(connectionOptions.map(({ key }) => key?.toString())).toEqual([
      "key-dev-drone-001",
      "key-dev-drone-002",
    ]);
    expect(connectionOptions.every(({ will }) => will?.retain === true)).toBe(
      true,
    );

    await fleet.shutdown();
  });
});

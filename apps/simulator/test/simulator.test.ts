import {
  commandAcknowledgementMessageSchema,
  connectionStatusMessageSchema,
  telemetryMessageSchema,
} from "@drone-fleet/protocol";
import type { IClientOptions } from "mqtt";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createConnectSimulatorClient,
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
  options: IClientOptions = {};
  readonly published: PublishedMessage[] = [];
  readonly endForces: Array<boolean | undefined> = [];
  readonly subscriptions: Array<{ topic: string; options: { qos: 1 } }> = [];
  reconnectCount = 0;
  private nextPublishBlocker: Promise<void> | undefined;
  private nextPublishError: Error | undefined;
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
    const blocker = this.nextPublishBlocker;
    this.nextPublishBlocker = undefined;
    await blocker;
    const error = this.nextPublishError;
    this.nextPublishError = undefined;
    if (error !== undefined) {
      throw error;
    }
  }

  async endAsync(force?: boolean): Promise<void> {
    this.endForces.push(force);
    this.connected = false;
  }

  reconnect(): this {
    this.reconnectCount += 1;
    this.connected = true;
    return this;
  }

  async subscribeAsync(topic: string, options: { qos: 1 }): Promise<void> {
    this.subscriptions.push({ topic, options });
  }

  on(event: "connect" | "offline" | "reconnect", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(
    event: "message",
    listener: (topic: string, payload: Buffer) => void,
  ): this;
  on(event: string, listener: (...args: never[]) => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  emit(event: "connect" | "offline" | "reconnect"): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener();
    }
  }

  emitMessage(topic: string, payload: Buffer): void {
    for (const listener of this.listeners.get("message") ?? []) {
      listener(topic, payload);
    }
  }

  blockNextPublish(): () => void {
    let release = (): void => undefined;
    this.nextPublishBlocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }

  failNextPublish(error: Error): void {
    this.nextPublishError = error;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("startSimulator", () => {
  it("fails the initial connection without retrying indefinitely", async () => {
    const connectionError = new Error("connection rejected");
    const mqttConnectAsync = vi.fn(async () => {
      throw connectionError;
    });
    const connectClient = createConnectSimulatorClient(mqttConnectAsync);

    await expect(
      connectClient("mqtts://example.iot:8883", { clientId: "drone-001" }),
    ).rejects.toBe(connectionError);
    expect(mqttConnectAsync).toHaveBeenCalledWith(
      "mqtts://example.iot:8883",
      { clientId: "drone-001" },
      false,
    );
  });

  it("passes transport-specific TLS options while enforcing a clean connection and LWT", async () => {
    vi.useFakeTimers();
    const client = new FakeMqttClient();
    let connectionOptions: IClientOptions | undefined;

    const simulator = await startSimulator(
      {
        deviceId: "dev-drone-001",
        mqttClientOptions: {
          ca: Buffer.from("ca"),
          cert: Buffer.from("certificate"),
          clean: false,
          clientId: "dev-drone-001",
          key: Buffer.from("private-key"),
          rejectUnauthorized: true,
        },
        mqttUrl: "mqtts://example.iot:8883",
        simulationSeed: "simulator-test",
        telemetryIntervalMs: 5000,
      },
      async (_url, options) => {
        connectionOptions = options;
        client.options = options;
        return client;
      },
    );

    expect(connectionOptions).toMatchObject({
      clean: true,
      clientId: "dev-drone-001",
      rejectUnauthorized: true,
      will: {
        topic: "fleet/v1/devices/dev-drone-001/status",
        qos: 1,
        retain: true,
      },
    });

    await simulator.shutdown();
  });

  it("publishes LWT, ONLINE, telemetry, and OFFLINE before disconnecting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T08:00:00.000Z"));
    const client = new FakeMqttClient();
    let connectionOptions: IClientOptions | undefined;
    const connectClient: ConnectSimulatorClient = async (_url, options) => {
      connectionOptions = options;
      client.options = options;
      return client;
    };

    const simulator = await startSimulator(
      {
        deviceId: "drone-001",
        mqttUrl: "mqtt://127.0.0.1:1883",
        simulationSeed: "simulator-test",
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
    expect(client.subscriptions).toEqual([
      {
        topic: "fleet/v1/devices/drone-001/commands",
        options: { qos: 1 },
      },
    ]);
    const online = connectionStatusMessageSchema.parse(
      JSON.parse(client.published[0]?.message ?? ""),
    );
    const firstTelemetry = telemetryMessageSchema.parse(
      JSON.parse(client.published[1]?.message ?? ""),
    );
    expect(online.payload).toEqual({ status: "ONLINE", reason: "CONNECTED" });
    expect(firstTelemetry.schemaVersion).toBe(2);
    expect(firstTelemetry.sequence).toBe(0);
    if (firstTelemetry.schemaVersion !== 2)
      throw new Error("expected v2 telemetry");
    expect(firstTelemetry.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    await vi.advanceTimersByTimeAsync(5000);
    const secondTelemetry = telemetryMessageSchema.parse(
      JSON.parse(client.published[2]?.message ?? ""),
    );
    expect(secondTelemetry.sequence).toBe(1);
    if (secondTelemetry.schemaVersion !== 2)
      throw new Error("expected v2 telemetry");
    expect(secondTelemetry.sessionId).toBe(firstTelemetry.sessionId);

    await simulator.shutdown();

    const offline = connectionStatusMessageSchema.parse(
      JSON.parse(client.published[3]?.message ?? ""),
    );
    expect(offline.payload).toEqual({ status: "OFFLINE", reason: "SHUTDOWN" });
    expect(client.published[3]?.options).toEqual({ qos: 1, retain: true });
    expect(client.endForces).toEqual([false]);
  });

  it("starts a new telemetry session when the simulator process restarts", async () => {
    vi.useFakeTimers();
    const firstClient = new FakeMqttClient();
    const config = {
      deviceId: "drone-001",
      mqttUrl: "mqtt://127.0.0.1:1883",
      simulationSeed: "simulator-test",
      telemetryIntervalMs: 5000,
    };
    const first = await startSimulator(config, async () => firstClient);
    const firstTelemetry = telemetryMessageSchema.parse(
      JSON.parse(firstClient.published[1]?.message ?? ""),
    );
    await first.shutdown();

    const secondClient = new FakeMqttClient();
    const second = await startSimulator(config, async () => secondClient);
    const secondTelemetry = telemetryMessageSchema.parse(
      JSON.parse(secondClient.published[1]?.message ?? ""),
    );
    expect(firstTelemetry.schemaVersion).toBe(2);
    expect(secondTelemetry.schemaVersion).toBe(2);
    if (
      firstTelemetry.schemaVersion !== 2 ||
      secondTelemetry.schemaVersion !== 2
    ) {
      throw new Error("expected v2 telemetry");
    }
    expect(secondTelemetry.sequence).toBe(0);
    expect(secondTelemetry.sessionId).not.toBe(firstTelemetry.sessionId);
    await second.shutdown();
  });

  it("does not reuse a sequence after an uncertain publish failure", async () => {
    vi.useFakeTimers();
    const logError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const client = new FakeMqttClient();
    const simulator = await startSimulator(
      {
        deviceId: "drone-001",
        mqttUrl: "mqtt://127.0.0.1:1883",
        simulationSeed: "simulator-test",
        telemetryIntervalMs: 5000,
      },
      async () => client,
    );

    client.failNextPublish(new Error("publish result unknown"));
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);
    const messages = client.published
      .filter(({ topic }) => topic.endsWith("/telemetry"))
      .map(({ message }) => telemetryMessageSchema.parse(JSON.parse(message)));
    expect(messages.map(({ sequence }) => sequence)).toEqual([0, 1, 2]);
    expect(messages.every((message) => message.schemaVersion === 2)).toBe(true);
    expect(logError).toHaveBeenCalledOnce();
    logError.mockRestore();
    await simulator.shutdown();
  });

  it("acknowledges RETURN_HOME and changes subsequent telemetry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T08:00:00.000Z"));
    const client = new FakeMqttClient();
    const simulator = await startSimulator(
      {
        deviceId: "drone-001",
        mqttUrl: "mqtt://127.0.0.1:1883",
        simulationSeed: "simulator-test",
        telemetryIntervalMs: 5000,
      },
      async () => client,
    );
    const commandId = "5c15de4f-6957-4f4f-b3cf-8cb9e733d63c";
    const command = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        commandId,
        deviceId: "drone-001",
        type: "RETURN_HOME",
        timestamp: "2026-09-25T08:00:00.000Z",
      }),
    );

    client.emitMessage("fleet/v1/devices/drone-001/commands", command);
    await vi.waitFor(() => expect(client.published).toHaveLength(3));

    const acknowledgement = commandAcknowledgementMessageSchema.parse(
      JSON.parse(client.published[2]?.message ?? ""),
    );
    expect(acknowledgement.commandId).toBe(commandId);
    expect(client.published[2]?.options).toEqual({ qos: 1, retain: false });

    await vi.advanceTimersByTimeAsync(5000);
    const telemetry = telemetryMessageSchema.parse(
      JSON.parse(client.published[3]?.message ?? ""),
    );
    expect(telemetry.payload.status).toBe("RETURNING_HOME");

    client.emitMessage("fleet/v1/devices/drone-001/commands", command);
    await vi.waitFor(() => expect(client.published).toHaveLength(5));
    expect(client.endForces).toEqual([]);

    await simulator.shutdown();
  });

  it("acknowledges REBOOT before reconnecting and announces ONLINE again", async () => {
    vi.useFakeTimers();
    const client = new FakeMqttClient();
    const simulator = await startSimulator(
      {
        deviceId: "drone-001",
        mqttUrl: "mqtt://127.0.0.1:1883",
        simulationSeed: "simulator-test",
        telemetryIntervalMs: 5000,
      },
      async () => client,
    );
    const command = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        commandId: "5c15de4f-6957-4f4f-b3cf-8cb9e733d63c",
        deviceId: "drone-001",
        type: "REBOOT",
        timestamp: "2026-09-25T08:00:00.000Z",
      }),
    );

    client.emitMessage("fleet/v1/devices/drone-001/commands", command);
    await vi.waitFor(() => expect(client.reconnectCount).toBe(1));

    expect(client.published[2]?.topic).toBe(
      "fleet/v1/devices/drone-001/command-acks",
    );
    expect(client.endForces).toEqual([false]);

    client.emit("connect");
    await vi.waitFor(() => expect(client.published).toHaveLength(5));
    const online = connectionStatusMessageSchema.parse(
      JSON.parse(client.published[3]?.message ?? ""),
    );
    expect(online.payload).toEqual({ status: "ONLINE", reason: "CONNECTED" });
    expect(client.subscriptions).toHaveLength(2);
    const initialTelemetry = telemetryMessageSchema.parse(
      JSON.parse(client.published[1]?.message ?? ""),
    );
    const reconnectTelemetry = telemetryMessageSchema.parse(
      JSON.parse(client.published[4]?.message ?? ""),
    );
    if (
      initialTelemetry.schemaVersion !== 2 ||
      reconnectTelemetry.schemaVersion !== 2
    ) {
      throw new Error("expected v2 telemetry");
    }
    expect(reconnectTelemetry.sessionId).toBe(initialTelemetry.sessionId);
    expect(reconnectTelemetry.sequence).toBe(1);

    await simulator.shutdown();
  });

  it("executes a redelivered command once after its first acknowledgement fails", async () => {
    vi.useFakeTimers();
    const client = new FakeMqttClient();
    const simulator = await startSimulator(
      {
        deviceId: "drone-001",
        mqttUrl: "mqtt://127.0.0.1:1883",
        simulationSeed: "simulator-test",
        telemetryIntervalMs: 5000,
      },
      async () => client,
    );
    const command = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        commandId: "5c15de4f-6957-4f4f-b3cf-8cb9e733d63c",
        deviceId: "drone-001",
        type: "REBOOT",
        timestamp: "2026-09-25T08:00:00.000Z",
      }),
    );
    const topic = "fleet/v1/devices/drone-001/commands";

    client.failNextPublish(new Error("ACK publish failed"));
    client.emitMessage(topic, command);
    await vi.waitFor(() => expect(client.published).toHaveLength(3));
    expect(client.endForces).toEqual([]);

    client.emitMessage(topic, command);
    await vi.waitFor(() => expect(client.reconnectCount).toBe(1));
    expect(client.endForces).toEqual([false]);

    client.emit("connect");
    await vi.waitFor(() => expect(client.published).toHaveLength(6));
    client.emitMessage(topic, command);
    await vi.waitFor(() => expect(client.published).toHaveLength(7));
    expect(client.reconnectCount).toBe(1);
    expect(client.endForces).toEqual([false]);

    await simulator.shutdown();
  });

  it("forces shutdown without publishing when disconnected", async () => {
    vi.useFakeTimers();
    const client = new FakeMqttClient();
    const simulator = await startSimulator(
      {
        deviceId: "drone-001",
        mqttUrl: "mqtt://127.0.0.1:1883",
        simulationSeed: "simulator-test",
        telemetryIntervalMs: 5000,
      },
      async () => client,
    );
    client.connected = false;

    await simulator.shutdown();

    expect(client.published).toHaveLength(2);
    expect(client.endForces).toEqual([true]);
  });

  it("refreshes the LWT timestamp before reconnecting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T08:00:00.000Z"));
    const client = new FakeMqttClient();
    const simulator = await startSimulator(
      {
        deviceId: "drone-001",
        mqttUrl: "mqtt://127.0.0.1:1883",
        simulationSeed: "simulator-test",
        telemetryIntervalMs: 5000,
      },
      async (_url, options) => {
        client.options = options;
        return client;
      },
    );

    vi.setSystemTime(new Date("2026-09-25T08:01:00.000Z"));
    client.connected = false;
    client.emit("reconnect");

    const refreshedLwt = connectionStatusMessageSchema.parse(
      JSON.parse(client.options.will?.payload.toString() ?? ""),
    );
    expect(refreshedLwt.timestamp).toBe("2026-09-25T08:01:00.000Z");
    expect(refreshedLwt.payload).toEqual({
      status: "OFFLINE",
      reason: "CONNECTION_LOST",
    });

    await simulator.shutdown();
  });

  it("does not restart the telemetry timer when shutdown overlaps reconnect", async () => {
    vi.useFakeTimers();
    const client = new FakeMqttClient();
    const simulator = await startSimulator(
      {
        deviceId: "drone-001",
        mqttUrl: "mqtt://127.0.0.1:1883",
        simulationSeed: "simulator-test",
        telemetryIntervalMs: 5000,
      },
      async (_url, options) => {
        client.options = options;
        return client;
      },
    );
    const releaseReconnectPublish = client.blockNextPublish();

    client.emit("connect");
    await vi.waitFor(() => expect(client.published).toHaveLength(3));
    await simulator.shutdown();
    releaseReconnectPublish();
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));

    expect(client.endForces).toEqual([false]);
  });
});

import {
  commandAcknowledgementMessageSchema,
  connectionStatusMessageSchema,
  telemetryMessageSchema,
} from "@drone-fleet/protocol";
import type { IClientOptions } from "mqtt";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import {
  createConnectSimulatorClient,
  startSimulator,
  type ConnectSimulatorClient,
  type OpenTelemetryBuffer,
  type SimulatorMqttClient,
} from "../src/simulator.js";
import { TelemetryBuffer } from "../src/telemetry-buffer.js";

interface PublishedMessage {
  topic: string;
  message: string;
  options: { qos: 0 | 1; retain: boolean };
}

const bufferRoot = mkdtempSync(join(tmpdir(), "drone-fleet-simulator-test-"));
let bufferNumber = 0;
function bufferSettings() {
  return {
    telemetryBufferPath: join(bufferRoot, `${++bufferNumber}.sqlite`),
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
  it("retries the same row after a PUBACK timeout without deleting it", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(1);
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
        telemetryPublishTimeoutMs: 1000,
        telemetryRetryBaseMs: 1000,
        telemetryRetryMaxMs: 1000,
        ...bufferSettings(),
      },
      async () => client,
    );
    const release = client.blockNextPublish();
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(simulator.getBufferStatus()).toMatchObject({
      backlog: 1,
      publishFailures: 1,
    });
    release();
    await vi.advanceTimersByTimeAsync(1000);
    const sequences = client.published
      .filter(({ topic }) => topic.endsWith("/telemetry"))
      .map(
        ({ message }) =>
          telemetryMessageSchema.parse(JSON.parse(message)).sequence,
      );
    expect(sequences).toEqual([0, 1, 1]);
    expect(simulator.getBufferStatus().backlog).toBe(0);
    await simulator.shutdown();
    logError.mockRestore();
    vi.restoreAllMocks();
  });

  it("retains an in-flight row when the connection closes before PUBACK", async () => {
    vi.useFakeTimers();
    const logError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const client = new FakeMqttClient();
    const settings = bufferSettings();
    const simulator = await startSimulator(
      {
        deviceId: "drone-001",
        mqttUrl: "mqtt://127.0.0.1:1883",
        simulationSeed: "simulator-test",
        telemetryIntervalMs: 5000,
        ...settings,
      },
      async () => client,
    );
    const release = client.blockNextPublish();
    await vi.advanceTimersByTimeAsync(5000);
    client.connected = false;
    vi.spyOn(client, "reconnect").mockImplementation(() => client);
    client.emit("close");
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(simulator.getBufferStatus()).toMatchObject({
      backlog: 1,
      publishFailures: 1,
    });
    await simulator.shutdown();

    const persisted = new TelemetryBuffer(
      settings.telemetryBufferPath,
      "drone-001",
      {
        maxRows: settings.telemetryBufferMaxRows,
        maxBytes: settings.telemetryBufferMaxBytes,
      },
    );
    expect(persisted.peekPendingPublish()?.sequence).toBe(1);
    persisted.close();
    logError.mockRestore();
  });

  it("replays old rows before telemetry generated after reconnect, at the configured pace", async () => {
    vi.useFakeTimers();
    const client = new FakeMqttClient();
    const simulator = await startSimulator(
      {
        deviceId: "drone-001",
        mqttUrl: "mqtt://127.0.0.1:1883",
        simulationSeed: "simulator-test",
        telemetryIntervalMs: 5000,
        telemetryReplayIntervalMs: 2000,
        ...bufferSettings(),
      },
      async () => client,
    );
    client.connected = false;
    vi.spyOn(client, "reconnect").mockImplementation(() => client);
    client.emit("close");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(simulator.getBufferStatus()).toMatchObject({ backlog: 2, rows: 3 });
    expect(simulator.getBufferStatus().brokerAcknowledgedUnconfirmed).toBe(1);

    client.connected = true;
    client.emit("connect");
    await vi.advanceTimersByTimeAsync(0);
    const sequences = () =>
      client.published
        .filter(({ topic }) => topic.endsWith("/telemetry"))
        .map(
          ({ message }) =>
            telemetryMessageSchema.parse(JSON.parse(message)).sequence,
        );
    expect(sequences()).toEqual([0, 1]);
    await vi.advanceTimersByTimeAsync(1999);
    expect(sequences()).toEqual([0, 1]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sequences()).toEqual([0, 1, 2]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sequences()).toEqual([0, 1, 2, 3]);
    expect(simulator.getBufferStatus()).toMatchObject({
      backlog: 0,
      replayed: 2,
    });
    expect(
      client.published
        .filter(({ topic }) => topic.endsWith("/telemetry"))
        .every(({ options }) => options.qos === 1),
    ).toBe(true);
    await simulator.shutdown();
  });

  it("resumes unpublished rows from a previous process before the new session", async () => {
    vi.useFakeTimers();
    const settings = bufferSettings();
    const config = {
      deviceId: "drone-001",
      mqttUrl: "mqtt://127.0.0.1:1883",
      simulationSeed: "simulator-test",
      telemetryIntervalMs: 5000,
      ...settings,
    };
    const firstClient = new FakeMqttClient();
    const first = await startSimulator(config, async () => firstClient);
    firstClient.connected = false;
    vi.spyOn(firstClient, "reconnect").mockImplementation(() => firstClient);
    firstClient.emit("close");
    await vi.advanceTimersByTimeAsync(5000);
    await first.shutdown();

    const secondClient = new FakeMqttClient();
    const second = await startSimulator(config, async () => secondClient);
    const initial = secondClient.published.find(({ topic }) =>
      topic.endsWith("/telemetry"),
    );
    const sent = telemetryMessageSchema.parse(
      JSON.parse(initial?.message ?? ""),
    );
    expect(sent.sequence).toBe(1);
    expect(second.getBufferStatus().backlog).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    const next = secondClient.published.filter(({ topic }) =>
      topic.endsWith("/telemetry"),
    )[1];
    const current = telemetryMessageSchema.parse(
      JSON.parse(next?.message ?? ""),
    );
    expect(current.sequence).toBe(0);
    if (sent.schemaVersion !== 2 || current.schemaVersion !== 2)
      throw new Error("v2 expected");
    expect(current.sessionId).not.toBe(sent.sessionId);
    await second.shutdown();
  });

  it("backs off publish failures and exposes the retry result", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(1);
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
        telemetryRetryBaseMs: 1000,
        telemetryRetryMaxMs: 1000,
        ...bufferSettings(),
      },
      async () => client,
    );
    client.failNextPublish(new Error("publish failed"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(simulator.getBufferStatus()).toMatchObject({
      backlog: 1,
      publishFailures: 1,
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(
      client.published.filter(({ topic }) => topic.endsWith("/telemetry")),
    ).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(
      client.published.filter(({ topic }) => topic.endsWith("/telemetry")),
    ).toHaveLength(3);
    expect(simulator.getBufferStatus()).toMatchObject({
      backlog: 0,
      replayed: 1,
    });
    await simulator.shutdown();
    logError.mockRestore();
    vi.restoreAllMocks();
  });

  it("uses exponential jittered delays for reconnect attempts", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(1);
    const client = new FakeMqttClient();
    const simulator = await startSimulator(
      {
        deviceId: "drone-001",
        mqttUrl: "mqtt://127.0.0.1:1883",
        simulationSeed: "simulator-test",
        telemetryIntervalMs: 5000,
        telemetryRetryBaseMs: 1000,
        telemetryRetryMaxMs: 4000,
        ...bufferSettings(),
      },
      async () => client,
    );
    client.connected = false;
    vi.spyOn(client, "reconnect").mockImplementation(() => {
      client.reconnectCount += 1;
      client.emit("close");
      return client;
    });
    client.emit("close");
    await vi.advanceTimersByTimeAsync(999);
    expect(client.reconnectCount).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.reconnectCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(client.reconnectCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.reconnectCount).toBe(2);
    expect(simulator.getBufferStatus().reconnectAttempts).toBe(2);
    await simulator.shutdown();
    vi.restoreAllMocks();
  });

  it("keeps generating into SQLite while MQTT is disconnected", async () => {
    vi.useFakeTimers();
    const client = new FakeMqttClient();
    const settings = bufferSettings();
    const simulator = await startSimulator(
      {
        deviceId: "drone-001",
        mqttUrl: "mqtt://127.0.0.1:1883",
        simulationSeed: "simulator-test",
        telemetryIntervalMs: 5000,
        ...settings,
      },
      async () => client,
    );

    client.connected = false;
    vi.spyOn(client, "reconnect").mockImplementation(() => client);
    client.emit("offline");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(simulator.getBufferStatus()).toMatchObject({
      rows: 3,
      healthy: true,
    });
    expect(
      client.published.filter(({ topic }) => topic.endsWith("/telemetry")),
    ).toHaveLength(1);
    await simulator.shutdown();

    const reopened = new TelemetryBuffer(
      settings.telemetryBufferPath,
      "drone-001",
      {
        maxRows: settings.telemetryBufferMaxRows,
        maxBytes: settings.telemetryBufferMaxBytes,
      },
    );
    expect(reopened.listUnconfirmed().map(({ sequence }) => sequence)).toEqual([
      0, 1, 2,
    ]);
    reopened.close();
  });

  it("stops generation and reports a buffer write failure", async () => {
    vi.useFakeTimers();
    const logError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const client = new FakeMqttClient();
    const settings = bufferSettings();
    const openBuffer: OpenTelemetryBuffer = (path, deviceId, limits) => {
      const buffer = new TelemetryBuffer(path, deviceId, limits);
      const append = buffer.append.bind(buffer);
      let calls = 0;
      buffer.append = (message) => {
        calls += 1;
        if (calls === 2) throw new Error("disk unavailable");
        return append(message);
      };
      return buffer;
    };
    const simulator = await startSimulator(
      {
        deviceId: "drone-001",
        mqttUrl: "mqtt://127.0.0.1:1883",
        simulationSeed: "simulator-test",
        telemetryIntervalMs: 5000,
        ...settings,
      },
      async () => client,
      openBuffer,
    );

    await vi.advanceTimersByTimeAsync(5000);
    expect(simulator.getBufferStatus()).toMatchObject({
      healthy: false,
      rows: 1,
      error: "disk unavailable",
    });
    expect(logError).toHaveBeenCalledWith(
      "テレメトリバッファの保存に失敗しました",
      expect.objectContaining({ deviceId: "drone-001" }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(simulator.getBufferStatus().rows).toBe(1);
    await simulator.shutdown();
    logError.mockRestore();
  });

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
        ...bufferSettings(),
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
      reconnectPeriod: 0,
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
        ...bufferSettings(),
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
      ...bufferSettings(),
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
        ...bufferSettings(),
      },
      async () => client,
    );

    client.failNextPublish(new Error("publish result unknown"));
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);
    const messages = client.published
      .filter(({ topic }) => topic.endsWith("/telemetry"))
      .map(({ message }) => telemetryMessageSchema.parse(JSON.parse(message)));
    expect(messages.map(({ sequence }) => sequence)).toEqual([0, 1, 1, 2]);
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
        ...bufferSettings(),
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
        ...bufferSettings(),
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
        ...bufferSettings(),
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
        ...bufferSettings(),
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
        ...bufferSettings(),
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
        ...bufferSettings(),
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

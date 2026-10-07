import {
  createCommandAcksTopic,
  createCommandsTopic,
  createStatusTopic,
  createTelemetryTopic,
  type TelemetryMessage,
} from "@drone-fleet/protocol";
import { connectAsync, type IClientOptions } from "mqtt";
import { randomUUID } from "node:crypto";

import { createCommandProcessor } from "./commands.js";
import {
  TelemetryBuffer,
  type TelemetryBufferStats,
} from "./telemetry-buffer.js";
import {
  createConnectionLostMessage,
  createOnlineMessage,
  createShutdownMessage,
  createTelemetryMessage,
} from "./messages.js";

export interface RunningSimulator {
  shutdown(): Promise<void>;
  getBufferStatus(): TelemetryBufferStats & {
    healthy: boolean;
    error?: string;
  };
}

export interface SimulatorDeviceConfig {
  deviceId: string;
  mqttClientOptions?: IClientOptions;
  mqttUrl: string;
  simulationSeed: string;
  telemetryIntervalMs: number;
  telemetryBufferPath: string;
  telemetryBufferMaxRows: number;
  telemetryBufferMaxBytes: number;
}

export interface SimulatorMqttClient {
  connected: boolean;
  options: IClientOptions;
  endAsync(force?: boolean): Promise<void>;
  reconnect(): this;
  subscribeAsync(topic: string, options: { qos: 1 }): Promise<unknown>;
  on(event: "connect" | "offline" | "reconnect", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(
    event: "message",
    listener: (topic: string, payload: Buffer) => void,
  ): this;
  publishAsync(
    topic: string,
    message: string,
    options: { qos: 0 | 1; retain: boolean },
  ): Promise<unknown>;
}

export type ConnectSimulatorClient = (
  url: string,
  options: IClientOptions,
) => Promise<SimulatorMqttClient>;

export type ConnectAsync = (
  url: string,
  options: IClientOptions,
  allowRetries: boolean,
) => Promise<SimulatorMqttClient>;

export type TelemetryBufferStore = Pick<
  TelemetryBuffer,
  "append" | "markAttempted" | "markPublished" | "stats" | "close"
>;
export type OpenTelemetryBuffer = (
  path: string,
  deviceId: string,
  limits: { maxRows: number; maxBytes: number },
) => TelemetryBufferStore;

export function createConnectSimulatorClient(
  mqttConnectAsync: ConnectAsync = connectAsync,
): ConnectSimulatorClient {
  return async (url, options) => mqttConnectAsync(url, options, false);
}

export const connectSimulatorClient = createConnectSimulatorClient();

export async function startSimulator(
  config: SimulatorDeviceConfig,
  connectClient: ConnectSimulatorClient = connectSimulatorClient,
  openBuffer: OpenTelemetryBuffer = (path, deviceId, limits) =>
    new TelemetryBuffer(path, deviceId, limits),
): Promise<RunningSimulator> {
  const statusTopic = createStatusTopic(config.deviceId);
  const telemetryTopic = createTelemetryTopic(config.deviceId);
  const commandsTopic = createCommandsTopic(config.deviceId);
  const commandAcksTopic = createCommandAcksTopic(config.deviceId);
  const commandProcessor = createCommandProcessor(config.deviceId);
  const sessionId = randomUUID();
  const buffer = openBuffer(config.telemetryBufferPath, config.deviceId, {
    maxRows: config.telemetryBufferMaxRows,
    maxBytes: config.telemetryBufferMaxBytes,
  });
  let bufferStats: TelemetryBufferStats;
  try {
    bufferStats = buffer.stats();
  } catch (error) {
    buffer.close();
    throw error;
  }
  const createWill = (): NonNullable<IClientOptions["will"]> => ({
    topic: statusTopic,
    payload: Buffer.from(
      JSON.stringify(
        createConnectionLostMessage(config.deviceId, new Date().toISOString()),
      ),
    ),
    qos: 1,
    retain: true,
  });
  let client: SimulatorMqttClient;
  try {
    client = await connectClient(config.mqttUrl, {
      ...config.mqttClientOptions,
      clean: true,
      clientId:
        config.mqttClientOptions?.clientId ?? `simulator-${config.deviceId}`,
      will: createWill(),
    });
  } catch (error) {
    buffer.close();
    throw error;
  }

  let sequence = 0;
  let telemetryTimer: NodeJS.Timeout | undefined;
  let publishInProgress = false;
  const inFlightTelemetry = new Set<Promise<void>>();
  let shuttingDown = false;
  let bufferError: Error | undefined;
  let initialConnectionHandled = false;
  let flightStatus: TelemetryMessage["payload"]["status"] | undefined;
  let commandQueue = Promise.resolve();

  const clearTelemetryTimer = (): void => {
    if (telemetryTimer !== undefined) {
      clearInterval(telemetryTimer);
      telemetryTimer = undefined;
    }
  };

  const failBuffer = (error: unknown): void => {
    bufferError = error instanceof Error ? error : new Error(String(error));
    clearTelemetryTimer();
    console.error("テレメトリバッファの保存に失敗しました", {
      deviceId: config.deviceId,
      error: bufferError,
    });
  };

  const publishTelemetry = async (): Promise<void> => {
    if (shuttingDown || bufferError !== undefined) {
      return;
    }

    const telemetry = createTelemetryMessage(
      config.deviceId,
      sessionId,
      sequence,
      new Date().toISOString(),
      flightStatus,
      config.simulationSeed,
    );
    let stored: boolean;
    try {
      const result = buffer.append(telemetry);
      sequence += 1;
      stored = result.stored;
      bufferStats = buffer.stats();
      if (result.discard !== undefined) {
        console.warn(
          "テレメトリバッファの上限に達したためデータを破棄しました",
          {
            deviceId: config.deviceId,
            ...result.discard,
          },
        );
      }
    } catch (error) {
      failBuffer(error);
      throw error;
    }

    if (!stored || !client.connected || publishInProgress) return;
    publishInProgress = true;
    try {
      try {
        buffer.markAttempted(
          telemetry.sessionId,
          telemetry.sequence,
          new Date().toISOString(),
        );
      } catch (error) {
        failBuffer(error);
        throw error;
      }
      try {
        await client.publishAsync(telemetryTopic, JSON.stringify(telemetry), {
          qos: 0,
          retain: false,
        });
      } catch (error) {
        console.error("テレメトリのMQTT送信に失敗しました", error);
        return;
      }
      try {
        buffer.markPublished(
          telemetry.sessionId,
          telemetry.sequence,
          new Date().toISOString(),
        );
      } catch (error) {
        failBuffer(error);
        throw error;
      }
    } finally {
      publishInProgress = false;
    }
  };

  const trackTelemetry = (): Promise<void> => {
    const operation = publishTelemetry();
    inFlightTelemetry.add(operation);
    void operation.then(
      () => inFlightTelemetry.delete(operation),
      () => inFlightTelemetry.delete(operation),
    );
    return operation;
  };

  const publishOnlineAndStartTelemetry = async (): Promise<void> => {
    await client.subscribeAsync(commandsTopic, { qos: 1 });
    const online = createOnlineMessage(
      config.deviceId,
      new Date().toISOString(),
    );
    await client.publishAsync(statusTopic, JSON.stringify(online), {
      qos: 1,
      retain: true,
    });
    await trackTelemetry();
    if (shuttingDown || bufferError !== undefined) {
      return;
    }
    telemetryTimer ??= setInterval(
      () =>
        void trackTelemetry().catch((error: unknown) => {
          console.error("テレメトリの送信に失敗しました", error);
        }),
      config.telemetryIntervalMs,
    );
    console.log(
      `${config.deviceId}が${config.mqttUrl}へ接続しました（送信間隔: ${config.telemetryIntervalMs}ms）`,
    );
  };

  // 切断中も生成とSQLite保存を続ける。再送は#111で実装する。
  client.on("reconnect", () => {
    client.options.will = createWill();
  });
  client.on("error", (error) => {
    console.error("MQTT接続でエラーが発生しました", error);
  });
  client.on("message", (topic, payload) => {
    commandQueue = commandQueue
      .then(async () => {
        const processed = commandProcessor.process(
          topic,
          payload,
          new Date().toISOString(),
        );
        if (processed === null || shuttingDown) {
          return;
        }

        await client.publishAsync(
          commandAcksTopic,
          JSON.stringify(processed.acknowledgement),
          { qos: 1, retain: false },
        );

        if (processed.action === "RETURN_HOME") {
          flightStatus = "RETURNING_HOME";
        } else if (processed.action === "REBOOT") {
          clearTelemetryTimer();
          await client.endAsync(false);
        }

        if (processed.action !== null) {
          commandProcessor.markProcessed(processed.acknowledgement.commandId);
        }

        if (processed.action === "REBOOT" && !shuttingDown) {
          client.options.will = createWill();
          client.reconnect();
        }
      })
      .catch((error: unknown) => {
        console.error("コマンドの処理に失敗しました", error);
      });
  });
  client.on("connect", () => {
    if (initialConnectionHandled && !shuttingDown) {
      void publishOnlineAndStartTelemetry().catch((error: unknown) => {
        console.error("再接続後の送信開始に失敗しました", error);
      });
    }
  });

  try {
    await publishOnlineAndStartTelemetry();
    initialConnectionHandled = true;
  } catch (error) {
    try {
      await client.endAsync(true);
    } finally {
      buffer.close();
    }
    throw error;
  }

  return {
    getBufferStatus() {
      return {
        ...bufferStats,
        healthy: bufferError === undefined,
        ...(bufferError === undefined ? {} : { error: bufferError.message }),
      };
    },
    async shutdown(): Promise<void> {
      if (shuttingDown) {
        return;
      }

      shuttingDown = true;
      clearTelemetryTimer();
      await Promise.allSettled([...inFlightTelemetry]);

      try {
        if (client.connected) {
          const offline = createShutdownMessage(
            config.deviceId,
            new Date().toISOString(),
          );
          try {
            await client.publishAsync(statusTopic, JSON.stringify(offline), {
              qos: 1,
              retain: true,
            });
          } finally {
            await client.endAsync(false);
          }
        } else {
          await client.endAsync(true);
        }
      } finally {
        buffer.close();
      }

      console.log(`${config.deviceId}のMQTT接続を終了しました`);
    },
  };
}

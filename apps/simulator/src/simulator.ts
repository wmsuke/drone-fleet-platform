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
  DEFAULT_TELEMETRY_REPLAY_INTERVAL_MS,
  DEFAULT_TELEMETRY_RETRY_BASE_MS,
  DEFAULT_TELEMETRY_RETRY_MAX_MS,
  DEFAULT_TELEMETRY_PUBLISH_TIMEOUT_MS,
} from "./config.js";
import { retryDelayMs } from "./retry.js";
import {
  TelemetryBuffer,
  type PendingTelemetryStats,
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
    backlog: number;
    brokerAcknowledgedUnconfirmed: number;
    oldestBacklogAt: string | null;
    replayed: number;
    publishFailures: number;
    reconnectAttempts: number;
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
  telemetryRetryBaseMs?: number;
  telemetryRetryMaxMs?: number;
  telemetryReplayIntervalMs?: number;
  telemetryPublishTimeoutMs?: number;
}

export interface SimulatorMqttClient {
  connected: boolean;
  options: IClientOptions;
  endAsync(force?: boolean): Promise<void>;
  reconnect(): this;
  subscribeAsync(topic: string, options: { qos: 1 }): Promise<unknown>;
  on(
    event: "connect" | "close" | "offline" | "reconnect",
    listener: () => void,
  ): this;
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
  | "append"
  | "markAttempted"
  | "markPublished"
  | "peekPendingPublish"
  | "pendingPublishStats"
  | "stats"
  | "close"
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
  const retryBaseMs =
    config.telemetryRetryBaseMs ?? DEFAULT_TELEMETRY_RETRY_BASE_MS;
  const retryMaxMs =
    config.telemetryRetryMaxMs ?? DEFAULT_TELEMETRY_RETRY_MAX_MS;
  const replayIntervalMs =
    config.telemetryReplayIntervalMs ?? DEFAULT_TELEMETRY_REPLAY_INTERVAL_MS;
  const publishTimeoutMs =
    config.telemetryPublishTimeoutMs ?? DEFAULT_TELEMETRY_PUBLISH_TIMEOUT_MS;
  const buffer = openBuffer(config.telemetryBufferPath, config.deviceId, {
    maxRows: config.telemetryBufferMaxRows,
    maxBytes: config.telemetryBufferMaxBytes,
  });
  let bufferStats: TelemetryBufferStats;
  let pendingStats: PendingTelemetryStats;
  try {
    bufferStats = buffer.stats();
    pendingStats = buffer.pendingPublishStats();
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
      reconnectPeriod: 0,
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
  let replayTimer: NodeJS.Timeout | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let publishInProgress = false;
  let reconnectFailures = 0;
  let publishFailures = 0;
  let consecutivePublishFailures = 0;
  let replayed = 0;
  let backlogRecoveryActive = false;
  let reconnectAttempts = 0;
  let manualReconnect = false;
  let abortPendingPublish: (() => void) | undefined;
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

  const clearReplayTimer = (): void => {
    if (replayTimer !== undefined) {
      clearTimeout(replayTimer);
      replayTimer = undefined;
    }
  };

  const clearReconnectTimer = (): void => {
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
  };

  const failBuffer = (error: unknown): void => {
    bufferError = error instanceof Error ? error : new Error(String(error));
    clearTelemetryTimer();
    clearReplayTimer();
    console.error("テレメトリバッファの保存に失敗しました", {
      deviceId: config.deviceId,
      error: bufferError,
    });
  };

  const refreshBufferStatus = (): void => {
    bufferStats = buffer.stats();
    pendingStats = buffer.pendingPublishStats();
  };

  const scheduleReconnect = (): void => {
    if (shuttingDown || reconnectTimer !== undefined || client.connected)
      return;
    const delay = retryDelayMs(reconnectFailures, retryBaseMs, retryMaxMs);
    reconnectFailures += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (shuttingDown || client.connected) return;
      reconnectAttempts += 1;
      client.options.will = createWill();
      client.reconnect();
    }, delay);
  };

  const scheduleReplay = (delay: number): void => {
    if (
      shuttingDown ||
      bufferError !== undefined ||
      !client.connected ||
      replayTimer !== undefined ||
      pendingStats.count === 0
    )
      return;
    replayTimer = setTimeout(() => {
      replayTimer = undefined;
      void sendNextPending().catch((error: unknown) => {
        console.error("テレメトリの再送に失敗しました", error);
      });
    }, delay);
  };

  const sendNextPending = async (): Promise<void> => {
    if (
      shuttingDown ||
      bufferError !== undefined ||
      !client.connected ||
      publishInProgress ||
      replayTimer !== undefined
    )
      return;
    let pending;
    try {
      pending = buffer.peekPendingPublish();
    } catch (error) {
      failBuffer(error);
      throw error;
    }
    if (pending === undefined) return;
    publishInProgress = true;
    try {
      try {
        buffer.markAttempted(
          pending.sessionId,
          pending.sequence,
          new Date().toISOString(),
        );
      } catch (error) {
        failBuffer(error);
        throw error;
      }
      try {
        const disconnected = new Promise<never>((_resolve, reject) => {
          abortPendingPublish = () =>
            reject(new Error("MQTT connection was lost during publish"));
        });
        let publishTimeout: NodeJS.Timeout | undefined;
        const timedOut = new Promise<never>((_resolve, reject) => {
          publishTimeout = setTimeout(
            () => reject(new Error("MQTT PUBACK timed out")),
            publishTimeoutMs,
          );
        });
        try {
          await Promise.race([
            client.publishAsync(telemetryTopic, pending.payloadJson, {
              qos: 1,
              retain: false,
            }),
            disconnected,
            timedOut,
          ]);
        } finally {
          abortPendingPublish = undefined;
          if (publishTimeout !== undefined) clearTimeout(publishTimeout);
        }
        if (!client.connected)
          throw new Error("MQTT connection was lost during publish");
      } catch (error) {
        publishFailures += 1;
        const delay = retryDelayMs(
          consecutivePublishFailures,
          retryBaseMs,
          retryMaxMs,
        );
        consecutivePublishFailures += 1;
        console.error("テレメトリのMQTT送信に失敗しました", error);
        scheduleReplay(delay);
        return;
      }
      try {
        buffer.markPublished(
          pending.sessionId,
          pending.sequence,
          new Date().toISOString(),
        );
        refreshBufferStatus();
      } catch (error) {
        failBuffer(error);
        throw error;
      }
      if (
        pending.attemptCount > 0 ||
        pending.sessionId !== sessionId ||
        pending.sequence < sequence - 1
      ) {
        replayed += 1;
      }
      consecutivePublishFailures = 0;
      if (pendingStats.count === 0 && backlogRecoveryActive) {
        backlogRecoveryActive = false;
        console.log("テレメトリの未送信分を送信しました", {
          deviceId: config.deviceId,
          replayed,
          publishFailures,
        });
      }
      scheduleReplay(replayIntervalMs);
    } finally {
      publishInProgress = false;
    }
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
    try {
      const result = buffer.append(telemetry);
      sequence += 1;
      refreshBufferStatus();
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

    if (client.connected) await sendNextPending();
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
    backlogRecoveryActive = pendingStats.count > 0;
    await trackTelemetry();
    scheduleReplay(0);
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
    if (pendingStats.count > 0) {
      console.log("テレメトリの未送信分を再送します", {
        deviceId: config.deviceId,
        backlog: pendingStats.count,
        brokerAcknowledgedUnconfirmed: bufferStats.rows - pendingStats.count,
        oldestBacklogAt: pendingStats.oldestCreatedAt,
      });
    }
  };

  // 切断中も生成とSQLite保存を続ける。接続試行はアプリ側で待機時間を制御する。
  client.on("offline", () => {
    clearReplayTimer();
    scheduleReconnect();
  });
  client.on("close", () => {
    abortPendingPublish?.();
    clearReplayTimer();
    if (!manualReconnect) scheduleReconnect();
  });
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
          manualReconnect = true;
          await client.endAsync(false);
        }

        if (processed.action !== null) {
          commandProcessor.markProcessed(processed.acknowledgement.commandId);
        }

        if (processed.action === "REBOOT" && !shuttingDown) {
          client.options.will = createWill();
          client.reconnect();
          manualReconnect = false;
        }
      })
      .catch((error: unknown) => {
        console.error("コマンドの処理に失敗しました", error);
      });
  });
  client.on("connect", () => {
    clearReconnectTimer();
    reconnectFailures = 0;
    clearReplayTimer();
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
        backlog: pendingStats.count,
        brokerAcknowledgedUnconfirmed: bufferStats.rows - pendingStats.count,
        oldestBacklogAt: pendingStats.oldestCreatedAt,
        replayed,
        publishFailures,
        reconnectAttempts,
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
      clearReplayTimer();
      clearReconnectTimer();
      abortPendingPublish?.();
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

import {
  createCommandAcksTopic,
  createCommandsTopic,
  createStatusTopic,
  createTelemetryTopic,
  type TelemetryMessage,
} from "@drone-fleet/protocol";
import { connectAsync, type IClientOptions } from "mqtt";

import type { SimulatorConfig } from "./config.js";
import { createCommandProcessor } from "./commands.js";
import {
  createConnectionLostMessage,
  createOnlineMessage,
  createShutdownMessage,
  createTelemetryMessage,
} from "./messages.js";

export interface RunningSimulator {
  shutdown(): Promise<void>;
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

export async function startSimulator(
  config: SimulatorConfig,
  connectClient: ConnectSimulatorClient = connectAsync,
): Promise<RunningSimulator> {
  const statusTopic = createStatusTopic(config.deviceId);
  const telemetryTopic = createTelemetryTopic(config.deviceId);
  const commandsTopic = createCommandsTopic(config.deviceId);
  const commandAcksTopic = createCommandAcksTopic(config.deviceId);
  const commandProcessor = createCommandProcessor(config.deviceId);
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
  const client = await connectClient(config.mqttUrl, {
    clean: true,
    clientId: `simulator-${config.deviceId}`,
    will: createWill(),
  });

  let sequence = 0;
  let telemetryTimer: NodeJS.Timeout | undefined;
  let publishInProgress = false;
  let shuttingDown = false;
  let initialConnectionHandled = false;
  let flightStatus: TelemetryMessage["payload"]["status"] | undefined;
  let commandQueue = Promise.resolve();

  const publishTelemetry = async (): Promise<void> => {
    if (publishInProgress || shuttingDown || !client.connected) {
      return;
    }

    publishInProgress = true;
    try {
      const telemetry = createTelemetryMessage(
        config.deviceId,
        sequence,
        new Date().toISOString(),
        flightStatus,
      );
      await client.publishAsync(telemetryTopic, JSON.stringify(telemetry), {
        qos: 0,
        retain: false,
      });
      sequence += 1;
    } finally {
      publishInProgress = false;
    }
  };

  const clearTelemetryTimer = (): void => {
    if (telemetryTimer !== undefined) {
      clearInterval(telemetryTimer);
      telemetryTimer = undefined;
    }
  };

  const publishOnlineAndStartTelemetry = async (): Promise<void> => {
    clearTelemetryTimer();
    await client.subscribeAsync(commandsTopic, { qos: 1 });
    const online = createOnlineMessage(
      config.deviceId,
      new Date().toISOString(),
    );
    await client.publishAsync(statusTopic, JSON.stringify(online), {
      qos: 1,
      retain: true,
    });
    await publishTelemetry();
    if (shuttingDown) {
      return;
    }
    telemetryTimer = setInterval(
      () =>
        void publishTelemetry().catch((error: unknown) => {
          console.error("テレメトリの送信に失敗しました", error);
        }),
      config.telemetryIntervalMs,
    );
    console.log(
      `${config.deviceId}が${config.mqttUrl}へ接続しました（送信間隔: ${config.telemetryIntervalMs}ms）`,
    );
  };

  client.on("offline", clearTelemetryTimer);
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
    await client.endAsync(true);
    throw error;
  }

  return {
    async shutdown(): Promise<void> {
      if (shuttingDown) {
        return;
      }

      shuttingDown = true;
      clearTelemetryTimer();

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

      console.log(`${config.deviceId}のMQTT接続を終了しました`);
    },
  };
}

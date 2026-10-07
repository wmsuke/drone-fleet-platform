import type { SimulatorConfig } from "./config.js";
import { join } from "node:path";
import {
  createDeviceMqttConnectionConfig,
  type DeviceMqttConnectionConfig,
} from "./mqtt-transport.js";
import {
  startSimulator,
  type ConnectSimulatorClient,
  type RunningSimulator,
} from "./simulator.js";

export interface RunningSimulatorFleet {
  shutdown(): Promise<void>;
  getBufferStatuses(): Record<
    string,
    ReturnType<RunningSimulator["getBufferStatus"]>
  >;
}

export type CreateDeviceMqttConnectionConfig = (
  deviceId: string,
) => Promise<DeviceMqttConnectionConfig>;

export function createDeviceId(
  index: number,
  prefix: string = "drone",
): string {
  if (!Number.isSafeInteger(index) || index < 1) {
    throw new TypeError("index must be a positive safe integer");
  }

  return `${prefix}-${String(index).padStart(3, "0")}`;
}

export async function startSimulatorFleet(
  config: SimulatorConfig,
  connectClient?: ConnectSimulatorClient,
  createConnectionConfig: CreateDeviceMqttConnectionConfig = async (deviceId) =>
    createDeviceMqttConnectionConfig(config.mqttTransport, deviceId),
): Promise<RunningSimulatorFleet> {
  const simulators: RunningSimulator[] = [];

  try {
    for (let index = 1; index <= config.droneCount; index += 1) {
      const deviceId = createDeviceId(index, config.deviceIdPrefix);
      const connectionConfig = await createConnectionConfig(deviceId);
      simulators.push(
        await startSimulator(
          {
            deviceId,
            mqttClientOptions: connectionConfig.clientOptions,
            mqttUrl: connectionConfig.url,
            simulationSeed: config.simulationSeed,
            telemetryIntervalMs: config.telemetryIntervalMs,
            telemetryBufferPath: join(
              config.telemetryBufferDirectory,
              `${deviceId}.sqlite`,
            ),
            telemetryBufferMaxRows: config.telemetryBufferMaxRows,
            telemetryBufferMaxBytes: config.telemetryBufferMaxBytes,
            telemetryRetryBaseMs: config.telemetryRetryBaseMs,
            telemetryRetryMaxMs: config.telemetryRetryMaxMs,
            telemetryReplayIntervalMs: config.telemetryReplayIntervalMs,
            telemetryPublishTimeoutMs: config.telemetryPublishTimeoutMs,
          },
          connectClient,
        ),
      );
    }
  } catch (error) {
    await Promise.allSettled(
      simulators.map(async (simulator) => simulator.shutdown()),
    );
    throw error;
  }

  return {
    getBufferStatuses() {
      return Object.fromEntries(
        simulators.map((simulator, index) => [
          createDeviceId(index + 1, config.deviceIdPrefix),
          simulator.getBufferStatus(),
        ]),
      );
    },
    async shutdown(): Promise<void> {
      await Promise.all(
        simulators.map(async (simulator) => simulator.shutdown()),
      );
    },
  };
}

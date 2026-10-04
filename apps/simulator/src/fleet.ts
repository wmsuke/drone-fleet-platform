import type { SimulatorConfig } from "./config.js";
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
    async shutdown(): Promise<void> {
      await Promise.all(
        simulators.map(async (simulator) => simulator.shutdown()),
      );
    },
  };
}

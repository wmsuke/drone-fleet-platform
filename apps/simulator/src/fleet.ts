import type { SimulatorConfig } from "./config.js";
import {
  startSimulator,
  type ConnectSimulatorClient,
  type RunningSimulator,
} from "./simulator.js";

export interface RunningSimulatorFleet {
  shutdown(): Promise<void>;
}

export function createDeviceId(index: number): string {
  if (!Number.isSafeInteger(index) || index < 1) {
    throw new TypeError("index must be a positive safe integer");
  }

  return `drone-${String(index).padStart(3, "0")}`;
}

export async function startSimulatorFleet(
  config: SimulatorConfig,
  connectClient?: ConnectSimulatorClient,
): Promise<RunningSimulatorFleet> {
  const simulators: RunningSimulator[] = [];

  try {
    for (let index = 1; index <= config.droneCount; index += 1) {
      simulators.push(
        await startSimulator(
          {
            deviceId: createDeviceId(index),
            mqttUrl: config.mqttUrl,
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

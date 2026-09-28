import { isValidDeviceId } from "@drone-fleet/protocol";

export interface SimulatorConfig {
  deviceId: string;
  mqttUrl: string;
  telemetryIntervalMs: number;
}

export const MAX_TIMER_DELAY_MS = 2_147_483_647;

function parseInteger(
  value: string,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }

  return parsed;
}

export function loadSimulatorConfig(
  environment: NodeJS.ProcessEnv = process.env,
): SimulatorConfig {
  const host = environment.MQTT_HOST ?? "127.0.0.1";
  const port = parseInteger(
    environment.MQTT_PORT ?? "1883",
    "MQTT_PORT",
    1,
    65_535,
  );
  const deviceId = environment.SIMULATOR_DEVICE_ID ?? "drone-001";
  const telemetryIntervalMs = parseInteger(
    environment.TELEMETRY_INTERVAL_MS ?? "5000",
    "TELEMETRY_INTERVAL_MS",
    1,
    MAX_TIMER_DELAY_MS,
  );

  if (!isValidDeviceId(deviceId)) {
    throw new TypeError("SIMULATOR_DEVICE_ID has an invalid format");
  }

  if (host.length === 0) {
    throw new TypeError("MQTT_HOST must not be empty");
  }

  return {
    deviceId,
    mqttUrl: `mqtt://${host}:${port}`,
    telemetryIntervalMs,
  };
}

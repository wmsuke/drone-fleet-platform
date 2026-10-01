export interface SimulatorConfig {
  droneCount: number;
  mqttUrl: string;
  simulationSeed: string;
  telemetryIntervalMs: number;
}

export const MAX_TIMER_DELAY_MS = 2_147_483_647;
export const MAX_DRONE_COUNT = 1_000;
export const DEFAULT_SIMULATION_SEED = "default";
export const MAX_SIMULATION_SEED_LENGTH = 128;

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
  const droneCount = parseInteger(
    environment.DRONE_COUNT ?? "10",
    "DRONE_COUNT",
    1,
    MAX_DRONE_COUNT,
  );
  const telemetryIntervalMs = parseInteger(
    environment.TELEMETRY_INTERVAL_MS ?? "5000",
    "TELEMETRY_INTERVAL_MS",
    1,
    MAX_TIMER_DELAY_MS,
  );
  const simulationSeed = environment.SIMULATION_SEED ?? DEFAULT_SIMULATION_SEED;

  if (host.length === 0) {
    throw new TypeError("MQTT_HOST must not be empty");
  }
  if (
    simulationSeed.length === 0 ||
    simulationSeed.length > MAX_SIMULATION_SEED_LENGTH
  ) {
    throw new TypeError(
      `SIMULATION_SEED must be between 1 and ${MAX_SIMULATION_SEED_LENGTH} characters`,
    );
  }

  return {
    droneCount,
    mqttUrl: `mqtt://${host}:${port}`,
    simulationSeed,
    telemetryIntervalMs,
  };
}

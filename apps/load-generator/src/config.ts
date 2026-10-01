import { isValidDeviceId } from "@drone-fleet/protocol";

export const MAX_TIMER_DELAY_MS = 2_147_483_647;
export const MAX_SIMULATION_SEED_LENGTH = 128;

export interface LoadGeneratorConfig {
  testId: string;
  sessionId: string;
  deviceStart: number;
  deviceCount: number;
  connectionRatePerSecond: number;
  telemetryIntervalMs: number;
  simulationSeed: string;
  maxMessages: number;
  maxDurationMs: number;
  mqttUrl: string;
  reportPath: string;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

function identifier(environment: NodeJS.ProcessEnv, name: string): string {
  const value = required(environment, name);
  if (!isValidDeviceId(value)) {
    throw new TypeError(
      `${name} must be 1-64 characters using only letters, numbers, hyphens, and underscores`,
    );
  }
  return value;
}

function integer(
  environment: NodeJS.ProcessEnv,
  name: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const raw = required(environment, name);
  if (!/^\d+$/.test(raw)) {
    throw new TypeError(`${name} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function positiveNumber(environment: NodeJS.ProcessEnv, name: string): number {
  const raw = required(environment, name);
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive number`);
  }
  return value;
}

export function loadLoadGeneratorConfig(
  environment: NodeJS.ProcessEnv = process.env,
): LoadGeneratorConfig {
  const testId = identifier(environment, "LOAD_TEST_ID");
  const sessionId = identifier(environment, "LOAD_SESSION_ID");
  const deviceStart = integer(environment, "LOAD_DEVICE_START", 1);
  const deviceCount = integer(environment, "LOAD_DEVICE_COUNT", 1);
  const finalDeviceIndex = deviceStart + deviceCount - 1;
  if (!Number.isSafeInteger(finalDeviceIndex)) {
    throw new RangeError(
      "LOAD_DEVICE_START and LOAD_DEVICE_COUNT exceed the safe range",
    );
  }

  const connectionRatePerSecond = positiveNumber(
    environment,
    "LOAD_CONNECTION_RATE_PER_SECOND",
  );
  const telemetryIntervalMs = integer(
    environment,
    "LOAD_TELEMETRY_INTERVAL_MS",
    1,
    MAX_TIMER_DELAY_MS,
  );
  const simulationSeed = required(environment, "LOAD_SIMULATION_SEED");
  if (simulationSeed.length > MAX_SIMULATION_SEED_LENGTH) {
    throw new RangeError(
      `LOAD_SIMULATION_SEED must be at most ${MAX_SIMULATION_SEED_LENGTH} characters`,
    );
  }
  const maxMessages = integer(environment, "LOAD_MAX_MESSAGES", 1);
  const maxDurationMs = integer(
    environment,
    "LOAD_MAX_DURATION_MS",
    1,
    MAX_TIMER_DELAY_MS,
  );
  const mqttHost = environment.MQTT_HOST ?? "localhost";
  if (mqttHost.length === 0) {
    throw new TypeError("MQTT_HOST must not be empty");
  }
  const mqttPort = integer(
    { MQTT_PORT: environment.MQTT_PORT ?? "1883" },
    "MQTT_PORT",
    1,
    65_535,
  );

  return {
    testId,
    sessionId,
    deviceStart,
    deviceCount,
    connectionRatePerSecond,
    telemetryIntervalMs,
    simulationSeed,
    maxMessages,
    maxDurationMs,
    mqttUrl: `mqtt://${mqttHost}:${mqttPort}`,
    reportPath:
      environment.LOAD_REPORT_PATH ??
      `load-results/${testId}-${sessionId}.json`,
  };
}

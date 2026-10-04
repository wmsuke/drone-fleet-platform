export interface LocalMqttTransportConfig {
  type: "local";
  url: string;
}

export interface AwsIotTransportConfig {
  type: "aws-iot";
  endpoint: string;
  rootCaPath: string;
  deviceCredentialsDirectory: string;
}

export type SimulatorMqttTransportConfig =
  | LocalMqttTransportConfig
  | AwsIotTransportConfig;

export interface SimulatorConfig {
  deviceIdPrefix: string;
  droneCount: number;
  mqttTransport: SimulatorMqttTransportConfig;
  simulationSeed: string;
  telemetryIntervalMs: number;
}

export const MAX_TIMER_DELAY_MS = 2_147_483_647;
export const MAX_DRONE_COUNT = 1_000;
export const DEFAULT_SIMULATION_SEED = "default";
export const MAX_SIMULATION_SEED_LENGTH = 128;
export const DEFAULT_DEVICE_ID_PREFIX = "drone";
export const MAX_DEVICE_ID_PREFIX_LENGTH = 59;

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

function requireEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) {
    throw new TypeError(`${name} is required when MQTT_TRANSPORT=aws-iot`);
  }
  return value;
}

function loadMqttTransport(
  environment: NodeJS.ProcessEnv,
): SimulatorMqttTransportConfig {
  const transport = environment.MQTT_TRANSPORT ?? "local";

  if (transport === "local") {
    const host = environment.MQTT_HOST ?? "127.0.0.1";
    const port = parseInteger(
      environment.MQTT_PORT ?? "1883",
      "MQTT_PORT",
      1,
      65_535,
    );
    if (host.length === 0) {
      throw new TypeError("MQTT_HOST must not be empty");
    }
    return { type: "local", url: `mqtt://${host}:${port}` };
  }

  if (transport === "aws-iot") {
    const endpoint = requireEnvironmentValue(environment, "AWS_IOT_ENDPOINT");
    if (!/^[A-Za-z0-9.-]+$/.test(endpoint)) {
      throw new TypeError(
        "AWS_IOT_ENDPOINT must be a hostname without a protocol or path",
      );
    }
    return {
      type: "aws-iot",
      endpoint,
      rootCaPath: requireEnvironmentValue(environment, "AWS_IOT_ROOT_CA_PATH"),
      deviceCredentialsDirectory: requireEnvironmentValue(
        environment,
        "AWS_IOT_DEVICE_CREDENTIALS_DIR",
      ),
    };
  }

  throw new TypeError("MQTT_TRANSPORT must be local or aws-iot");
}

export function loadSimulatorConfig(
  environment: NodeJS.ProcessEnv = process.env,
): SimulatorConfig {
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
  const deviceIdPrefix =
    environment.DEVICE_ID_PREFIX ?? DEFAULT_DEVICE_ID_PREFIX;

  if (
    deviceIdPrefix.length > MAX_DEVICE_ID_PREFIX_LENGTH ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(deviceIdPrefix)
  ) {
    throw new TypeError(
      `DEVICE_ID_PREFIX must be between 1 and ${MAX_DEVICE_ID_PREFIX_LENGTH} letters, numbers, hyphens, or underscores and start with a letter or number`,
    );
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
    deviceIdPrefix,
    droneCount,
    mqttTransport: loadMqttTransport(environment),
    simulationSeed,
    telemetryIntervalMs,
  };
}

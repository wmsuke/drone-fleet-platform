import { isValidDeviceId } from "@drone-fleet/protocol";

export const MAX_TIMER_DELAY_MS = 2_147_483_647;
export const MAX_SIMULATION_SEED_LENGTH = 128;
export const AWS_IOT_PROJECT_MONTHLY_MESSAGE_LIMIT = 200_000;

export type LoadTransport = "local" | "aws-iot";

export interface AwsIotConfig {
  ruleName: string;
  monthToDateMessages: number;
  rootCaPath: string;
  deviceCredentialsDirectory: string;
}

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
  measurementStartAt?: Date;
  measurementDurationMs?: number;
  mqttUrl: string;
  transport: LoadTransport;
  topicPrefix: string;
  awsIot?: AwsIotConfig;
  reportPath: string;
  readyPath?: string;
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
  const transport = environment.LOAD_TRANSPORT ?? "local";
  if (transport !== "local" && transport !== "aws-iot") {
    throw new TypeError("LOAD_TRANSPORT must be local or aws-iot");
  }
  const measurementStartAt = (() => {
    const raw = environment.LOAD_MEASUREMENT_START_AT;
    if (raw === undefined || raw.length === 0) return undefined;
    const value = new Date(raw);
    if (!Number.isFinite(value.getTime())) {
      throw new TypeError("LOAD_MEASUREMENT_START_AT must be an ISO date");
    }
    return value;
  })();
  const measurementDurationMs =
    measurementStartAt === undefined
      ? undefined
      : integer(
          environment,
          "LOAD_MEASUREMENT_DURATION_MS",
          1,
          MAX_TIMER_DELAY_MS,
        );
  const mqttHost =
    transport === "aws-iot"
      ? required(environment, "AWS_IOT_ENDPOINT")
      : (environment.MQTT_HOST ?? "localhost");
  if (mqttHost.length === 0) {
    throw new TypeError("MQTT_HOST must not be empty");
  }
  const mqttPortName = transport === "aws-iot" ? "AWS_IOT_PORT" : "MQTT_PORT";
  const mqttPort = integer(
    {
      [mqttPortName]:
        environment[mqttPortName] ??
        (transport === "aws-iot" ? "8883" : "1883"),
    },
    mqttPortName,
    1,
    65_535,
  );

  const awsIot = (() => {
    if (transport !== "aws-iot") return undefined;
    const ruleName = required(environment, "AWS_IOT_RULE_NAME");
    if (!/^[A-Za-z0-9_]+$/.test(ruleName)) {
      throw new TypeError(
        "AWS_IOT_RULE_NAME must use only letters, numbers, and underscores",
      );
    }
    const monthToDateMessages = integer(
      environment,
      "AWS_IOT_MONTH_TO_DATE_MESSAGES",
      0,
      AWS_IOT_PROJECT_MONTHLY_MESSAGE_LIMIT,
    );
    if (
      monthToDateMessages + maxMessages >
      AWS_IOT_PROJECT_MONTHLY_MESSAGE_LIMIT
    ) {
      throw new RangeError(
        `AWS IoT message budget exceeds the project monthly limit of ${AWS_IOT_PROJECT_MONTHLY_MESSAGE_LIMIT}`,
      );
    }
    if (environment.AWS_IOT_FREE_TIER_CONFIRMED !== "true") {
      throw new TypeError(
        "AWS_IOT_FREE_TIER_CONFIRMED must be true after checking Billing Free Tier eligibility and remaining usage",
      );
    }
    return {
      ruleName,
      monthToDateMessages,
      rootCaPath: required(environment, "AWS_IOT_ROOT_CA_PATH"),
      deviceCredentialsDirectory: required(
        environment,
        "AWS_IOT_DEVICE_CREDENTIALS_DIR",
      ),
    };
  })();

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
    ...(measurementStartAt === undefined
      ? {}
      : { measurementStartAt, measurementDurationMs }),
    mqttUrl: `${transport === "aws-iot" ? "mqtts" : "mqtt"}://${mqttHost}:${mqttPort}`,
    transport,
    topicPrefix: awsIot === undefined ? "" : `$aws/rules/${awsIot.ruleName}/`,
    ...(awsIot === undefined ? {} : { awsIot }),
    reportPath:
      environment.LOAD_REPORT_PATH ??
      `load-results/${testId}-${sessionId}.json`,
    ...(environment.LOAD_READY_PATH === undefined ||
    environment.LOAD_READY_PATH.length === 0
      ? {}
      : { readyPath: environment.LOAD_READY_PATH }),
  };
}

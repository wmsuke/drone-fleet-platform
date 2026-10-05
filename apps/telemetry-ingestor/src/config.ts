export interface TelemetryIngestorConfig {
  mqttTransport: TelemetryMqttTransportConfig;
  offlineTimeoutMs: number;
  telemetryBatchSize: number;
  telemetryFlushIntervalMs: number;
  telemetryMaxBufferSize: number;
  loadMetrics?: LoadMetricsConfig;
}

export interface LocalMqttTransportConfig {
  type: "local";
  url: string;
}

export interface AwsIotMqttTransportConfig {
  type: "aws-iot";
  endpoint: string;
  rootCaPath: string;
  certificatePath: string;
  privateKeyPath: string;
  clientId: string;
}

export type TelemetryMqttTransportConfig =
  | LocalMqttTransportConfig
  | AwsIotMqttTransportConfig;

export interface LoadMetricsConfig {
  testId: string;
  sessionId: string;
  reportPath: string;
  measurementStartAt?: Date;
  measurementEndAt?: Date;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function parseBoolean(value: string, name: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new TypeError(`${name} must be true or false`);
}

function requiredIdentifier(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name];
  if (value === undefined || !IDENTIFIER_PATTERN.test(value)) {
    throw new TypeError(
      `${name} must be 1-64 characters using only letters, numbers, hyphens, and underscores`,
    );
  }
  return value;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("MQTT_PORT must be an integer between 1 and 65535");
  }
  return port;
}

function requiredEnvironmentValue(
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
): TelemetryMqttTransportConfig {
  const transport = environment.MQTT_TRANSPORT ?? "local";
  if (transport === "local") {
    const host = environment.MQTT_HOST ?? "127.0.0.1";
    if (host.length === 0) {
      throw new TypeError("MQTT_HOST must not be empty");
    }
    const port = parsePort(environment.MQTT_PORT ?? "1883");
    return { type: "local", url: `mqtt://${host}:${port}` };
  }

  if (transport === "aws-iot") {
    const endpoint = requiredEnvironmentValue(environment, "AWS_IOT_ENDPOINT");
    if (!/^[A-Za-z0-9.-]+$/.test(endpoint)) {
      throw new TypeError(
        "AWS_IOT_ENDPOINT must be a hostname without a protocol or path",
      );
    }
    const clientId = requiredEnvironmentValue(
      environment,
      "AWS_IOT_TELEMETRY_INGESTOR_CLIENT_ID",
    );
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(clientId)) {
      throw new TypeError(
        "AWS_IOT_TELEMETRY_INGESTOR_CLIENT_ID must be 1-128 letters, numbers, hyphens, or underscores",
      );
    }
    return {
      type: "aws-iot",
      endpoint,
      rootCaPath: requiredEnvironmentValue(environment, "AWS_IOT_ROOT_CA_PATH"),
      certificatePath: requiredEnvironmentValue(
        environment,
        "AWS_IOT_TELEMETRY_INGESTOR_CERTIFICATE_PATH",
      ),
      privateKeyPath: requiredEnvironmentValue(
        environment,
        "AWS_IOT_TELEMETRY_INGESTOR_PRIVATE_KEY_PATH",
      ),
      clientId,
    };
  }

  throw new TypeError("MQTT_TRANSPORT must be local or aws-iot");
}

function positiveInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  defaultValue: string,
): number {
  const value = Number(environment[name] ?? defaultValue);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

export function loadTelemetryIngestorConfig(
  environment: NodeJS.ProcessEnv = process.env,
): TelemetryIngestorConfig {
  const offlineTimeoutMs = Number(environment.OFFLINE_TIMEOUT_MS ?? "15000");
  if (!Number.isSafeInteger(offlineTimeoutMs) || offlineTimeoutMs < 1) {
    throw new TypeError("OFFLINE_TIMEOUT_MS must be a positive integer");
  }
  const loadMetricsEnabled = parseBoolean(
    environment.LOAD_METRICS_ENABLED ?? "false",
    "LOAD_METRICS_ENABLED",
  );
  const loadMetrics = loadMetricsEnabled
    ? (() => {
        const testId = requiredIdentifier(environment, "LOAD_TEST_ID");
        const sessionId = requiredIdentifier(environment, "LOAD_SESSION_ID");
        return {
          testId,
          sessionId,
          reportPath:
            environment.LOAD_METRICS_REPORT_PATH ??
            `load-results/${testId}-${sessionId}-ingestor.json`,
          ...(environment.LOAD_MEASUREMENT_START_AT === undefined ||
          environment.LOAD_MEASUREMENT_START_AT.length === 0
            ? {}
            : (() => {
                const measurementStartAt = new Date(
                  environment.LOAD_MEASUREMENT_START_AT,
                );
                const measurementEndAt = new Date(
                  environment.LOAD_MEASUREMENT_END_AT ?? "",
                );
                if (
                  !Number.isFinite(measurementStartAt.getTime()) ||
                  !Number.isFinite(measurementEndAt.getTime()) ||
                  measurementEndAt <= measurementStartAt
                ) {
                  throw new TypeError(
                    "LOAD_MEASUREMENT_START_AT and LOAD_MEASUREMENT_END_AT must be a valid increasing interval",
                  );
                }
                return { measurementStartAt, measurementEndAt };
              })()),
        };
      })()
    : undefined;
  return {
    mqttTransport: loadMqttTransport(environment),
    offlineTimeoutMs,
    telemetryBatchSize: positiveInteger(
      environment,
      "TELEMETRY_BATCH_SIZE",
      "100",
    ),
    telemetryFlushIntervalMs: positiveInteger(
      environment,
      "TELEMETRY_FLUSH_INTERVAL_MS",
      "50",
    ),
    telemetryMaxBufferSize: positiveInteger(
      environment,
      "TELEMETRY_MAX_BUFFER_SIZE",
      "10000",
    ),
    ...(loadMetrics === undefined ? {} : { loadMetrics }),
  };
}

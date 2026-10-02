export interface TelemetryIngestorConfig {
  mqttUrl: string;
  offlineTimeoutMs: number;
  telemetryBatchSize: number;
  telemetryFlushIntervalMs: number;
  telemetryMaxBufferSize: number;
  loadMetrics?: LoadMetricsConfig;
}

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
  const host = environment.MQTT_HOST ?? "127.0.0.1";
  if (host.length === 0) {
    throw new TypeError("MQTT_HOST must not be empty");
  }

  const port = parsePort(environment.MQTT_PORT ?? "1883");
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
    mqttUrl: `mqtt://${host}:${port}`,
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

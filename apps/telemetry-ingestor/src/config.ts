export interface TelemetryIngestorConfig {
  mqttUrl: string;
  offlineTimeoutMs: number;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("MQTT_PORT must be an integer between 1 and 65535");
  }
  return port;
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
  return { mqttUrl: `mqtt://${host}:${port}`, offlineTimeoutMs };
}

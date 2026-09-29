export interface TelemetryIngestorConfig {
  mqttUrl: string;
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
  return { mqttUrl: `mqtt://${host}:${port}` };
}

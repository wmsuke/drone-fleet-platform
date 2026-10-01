export interface ApiConfig {
  dashboardOrigin: string | null;
  host: string;
  port: number;
  mqttUrl: string;
}

function parseDashboardOrigin(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const normalized = value.trim().replace(/\/+$/, "");
  if (normalized.length === 0) {
    throw new TypeError("DASHBOARD_ORIGIN must not be empty");
  }
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new TypeError("DASHBOARD_ORIGIN must be an HTTP(S) origin");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.origin !== normalized ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new TypeError("DASHBOARD_ORIGIN must be an HTTP(S) origin");
  }
  return url.origin;
}

export function loadApiConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ApiConfig {
  const port = Number(environment.API_PORT ?? "3000");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("API_PORT must be an integer between 1 and 65535");
  }
  const mqttHost = environment.MQTT_HOST ?? "127.0.0.1";
  if (mqttHost.length === 0) {
    throw new TypeError("MQTT_HOST must not be empty");
  }
  const mqttPort = Number(environment.MQTT_PORT ?? "1883");
  if (!Number.isSafeInteger(mqttPort) || mqttPort < 1 || mqttPort > 65_535) {
    throw new TypeError("MQTT_PORT must be an integer between 1 and 65535");
  }
  return {
    dashboardOrigin: parseDashboardOrigin(environment.DASHBOARD_ORIGIN),
    host: environment.API_HOST ?? "127.0.0.1",
    port,
    mqttUrl: `mqtt://${mqttHost}:${mqttPort}`,
  };
}

export interface ApiConfig {
  host: string;
  port: number;
  mqttUrl: string;
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
    host: environment.API_HOST ?? "127.0.0.1",
    port,
    mqttUrl: `mqtt://${mqttHost}:${mqttPort}`,
  };
}

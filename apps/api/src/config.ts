export interface ApiConfig {
  dashboardOrigin: string | null;
  host: string;
  port: number;
  mqttTransport: ApiMqttTransportConfig;
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

export type ApiMqttTransportConfig =
  | LocalMqttTransportConfig
  | AwsIotMqttTransportConfig;

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
): ApiMqttTransportConfig {
  const transport = environment.MQTT_TRANSPORT ?? "local";
  if (transport === "local") {
    const host = environment.MQTT_HOST ?? "127.0.0.1";
    if (host.length === 0) {
      throw new TypeError("MQTT_HOST must not be empty");
    }
    const port = Number(environment.MQTT_PORT ?? "1883");
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new TypeError("MQTT_PORT must be an integer between 1 and 65535");
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
    const clientId = requireEnvironmentValue(
      environment,
      "AWS_IOT_API_CLIENT_ID",
    );
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(clientId)) {
      throw new TypeError(
        "AWS_IOT_API_CLIENT_ID must be 1-128 letters, numbers, hyphens, or underscores",
      );
    }
    return {
      type: "aws-iot",
      endpoint,
      rootCaPath: requireEnvironmentValue(environment, "AWS_IOT_ROOT_CA_PATH"),
      certificatePath: requireEnvironmentValue(
        environment,
        "AWS_IOT_API_CERTIFICATE_PATH",
      ),
      privateKeyPath: requireEnvironmentValue(
        environment,
        "AWS_IOT_API_PRIVATE_KEY_PATH",
      ),
      clientId,
    };
  }

  throw new TypeError("MQTT_TRANSPORT must be local or aws-iot");
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
  return {
    dashboardOrigin: parseDashboardOrigin(environment.DASHBOARD_ORIGIN),
    host: environment.API_HOST ?? "127.0.0.1",
    port,
    mqttTransport: loadMqttTransport(environment),
  };
}

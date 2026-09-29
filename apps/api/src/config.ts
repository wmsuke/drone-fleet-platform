export interface ApiConfig {
  host: string;
  port: number;
}

export function loadApiConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ApiConfig {
  const port = Number(environment.API_PORT ?? "3000");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("API_PORT must be an integer between 1 and 65535");
  }
  return { host: environment.API_HOST ?? "127.0.0.1", port };
}

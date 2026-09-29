import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.js";

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

function requireValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) {
    throw new TypeError(`${name} must not be empty`);
  }
  return value;
}

export function loadDatabaseConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DatabaseConfig {
  const port = Number(requireValue(environment, "POSTGRES_PORT"));
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("POSTGRES_PORT must be an integer between 1 and 65535");
  }

  return {
    host: requireValue(environment, "POSTGRES_HOST"),
    port,
    database: requireValue(environment, "POSTGRES_DB"),
    user: requireValue(environment, "POSTGRES_USER"),
    password: requireValue(environment, "POSTGRES_PASSWORD"),
  };
}

export function createDatabaseUrl(config: DatabaseConfig): string {
  const user = encodeURIComponent(config.user);
  const password = encodeURIComponent(config.password);
  const database = encodeURIComponent(config.database);
  return `postgres://${user}:${password}@${config.host}:${config.port}/${database}`;
}

export function createDatabase(config = loadDatabaseConfig()) {
  const client = postgres(createDatabaseUrl(config));
  const db = drizzle(client, { schema });
  return { client, db };
}

export type Database = ReturnType<typeof createDatabase>["db"];

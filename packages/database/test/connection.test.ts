import { describe, expect, it } from "vitest";

import { createDatabaseUrl, loadDatabaseConfig } from "../src/connection.js";

const environment = {
  POSTGRES_HOST: "127.0.0.1",
  POSTGRES_PORT: "5432",
  POSTGRES_DB: "drone_fleet",
  POSTGRES_USER: "drone_fleet",
  POSTGRES_PASSWORD: "local password",
};

describe("loadDatabaseConfig", () => {
  it("loads PostgreSQL connection settings", () => {
    expect(loadDatabaseConfig(environment)).toEqual({
      host: "127.0.0.1",
      port: 5432,
      database: "drone_fleet",
      user: "drone_fleet",
      password: "local password",
    });
  });

  it.each([
    ["missing host", { ...environment, POSTGRES_HOST: undefined }],
    ["empty database", { ...environment, POSTGRES_DB: "" }],
    ["invalid port", { ...environment, POSTGRES_PORT: "0" }],
    ["non-integer port", { ...environment, POSTGRES_PORT: "5432.5" }],
  ])("rejects %s", (_name, input) => {
    expect(() => loadDatabaseConfig(input)).toThrow(TypeError);
  });
});

describe("createDatabaseUrl", () => {
  it("escapes credentials and database names", () => {
    expect(
      createDatabaseUrl({
        host: "db.example.test",
        port: 5432,
        database: "fleet/local",
        user: "fleet user",
        password: "password@local",
      }),
    ).toBe(
      "postgres://fleet%20user:password%40local@db.example.test:5432/fleet%2Flocal",
    );
  });
});

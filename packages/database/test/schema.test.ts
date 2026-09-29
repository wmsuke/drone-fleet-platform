import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  commandStatusEnum,
  commands,
  connectionStatusEnum,
  devices,
  flightStatusEnum,
  telemetry,
} from "../src/schema.js";

describe("database schema", () => {
  it("defines separate connection and flight states", () => {
    expect(connectionStatusEnum.enumValues).toEqual(["ONLINE", "OFFLINE"]);
    expect(flightStatusEnum.enumValues).toEqual([
      "IDLE",
      "FLYING",
      "RETURNING_HOME",
    ]);
    expect(devices.connectionStatus.name).toBe("connection_status");
    expect(telemetry.flightStatus.name).toBe("flight_status");
  });

  it("distinguishes device timestamps from server receipt timestamps", () => {
    expect(telemetry.deviceTimestamp.name).toBe("device_timestamp");
    expect(telemetry.receivedAt.name).toBe("received_at");
    expect(telemetry.receivedAt.hasDefault).toBe(true);
    expect(devices.lastReceivedAt.name).toBe("last_received_at");
  });

  it("defines primary keys, foreign keys, checks, and indexes", () => {
    const deviceConfig = getTableConfig(devices);
    const telemetryConfig = getTableConfig(telemetry);
    const commandConfig = getTableConfig(commands);

    expect(deviceConfig.primaryKeys).toHaveLength(1);
    expect(telemetryConfig.foreignKeys).toHaveLength(1);
    expect(telemetryConfig.checks).toHaveLength(6);
    expect(telemetryConfig.indexes.map(({ config }) => config.name)).toEqual([
      "telemetry_device_sequence_unique",
      "telemetry_device_received_at_idx",
    ]);
    expect(commandConfig.foreignKeys).toHaveLength(1);
    expect(commandConfig.checks).toHaveLength(1);
    expect(commandConfig.indexes.map(({ config }) => config.name)).toEqual([
      "commands_device_created_at_idx",
      "commands_status_created_at_idx",
    ]);
  });

  it("defines all Phase 1 command states", () => {
    expect(commandStatusEnum.enumValues).toEqual([
      "PENDING",
      "SENT",
      "ACKNOWLEDGED",
      "FAILED",
      "TIMED_OUT",
    ]);
  });
});

import {
  connectionStatusMessageSchema,
  telemetryMessageSchema,
  type ConnectionStatusMessage,
  type TelemetryMessage,
} from "@drone-fleet/protocol";

import { calculateDroneState } from "./state.js";

export function createOnlineMessage(
  deviceId: string,
  timestamp: string,
): ConnectionStatusMessage {
  return connectionStatusMessageSchema.parse({
    schemaVersion: 1,
    deviceId,
    timestamp,
    payload: { status: "ONLINE", reason: "CONNECTED" },
  });
}

export function createConnectionLostMessage(
  deviceId: string,
  timestamp: string,
): ConnectionStatusMessage {
  return connectionStatusMessageSchema.parse({
    schemaVersion: 1,
    deviceId,
    timestamp,
    payload: { status: "OFFLINE", reason: "CONNECTION_LOST" },
  });
}

export function createShutdownMessage(
  deviceId: string,
  timestamp: string,
): ConnectionStatusMessage {
  return connectionStatusMessageSchema.parse({
    schemaVersion: 1,
    deviceId,
    timestamp,
    payload: { status: "OFFLINE", reason: "SHUTDOWN" },
  });
}

export function createTelemetryMessage(
  deviceId: string,
  sequence: number,
  timestamp: string,
): TelemetryMessage {
  return telemetryMessageSchema.parse({
    schemaVersion: 1,
    deviceId,
    sequence,
    timestamp,
    payload: calculateDroneState(sequence),
  });
}

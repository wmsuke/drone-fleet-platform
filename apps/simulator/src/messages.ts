import {
  connectionStatusMessageSchema,
  telemetryMessageSchema,
  type ConnectionStatusMessage,
  type TelemetryMessage,
} from "@drone-fleet/protocol";

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
    payload: {
      battery: Math.max(0, 100 - (sequence % 101)),
      latitude: 35.681236,
      longitude: 139.767125,
      altitude: 0,
      temperature: 25,
      status: "IDLE",
    },
  });
}

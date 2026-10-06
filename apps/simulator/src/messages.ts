import {
  connectionStatusMessageSchema,
  telemetryV2MessageSchema,
  type ConnectionStatusMessage,
  type TelemetryV2Message,
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
  sessionId: string,
  sequence: number,
  timestamp: string,
  status?: TelemetryV2Message["payload"]["status"],
  simulationSeed?: string,
): TelemetryV2Message {
  const state = calculateDroneState(sequence, simulationSeed, deviceId);

  return telemetryV2MessageSchema.parse({
    schemaVersion: 2,
    deviceId,
    sessionId,
    sequence,
    timestamp,
    payload: status === undefined ? state : { ...state, status },
  });
}

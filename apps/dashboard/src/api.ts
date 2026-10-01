export class ApiError extends Error {
  constructor(public readonly status: number) {
    super(`API request failed with status ${status}`);
  }
}

export interface DeviceListItem {
  deviceId: string;
  connectionStatus: "ONLINE" | "OFFLINE";
  battery: number | null;
  flightStatus: "IDLE" | "FLYING" | "RETURNING_HOME" | null;
  lastReceivedAt: string | null;
}

export interface LatestTelemetry {
  sequence: number;
  deviceTimestamp: string;
  receivedAt: string;
  battery: number;
  latitude: number;
  longitude: number;
  altitude: number;
  temperature: number;
  flightStatus: "IDLE" | "FLYING" | "RETURNING_HOME";
}

export interface DeviceDetail {
  deviceId: string;
  model: string | null;
  softwareVersion: string | null;
  connectionStatus: "ONLINE" | "OFFLINE";
  lastReceivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  latestTelemetry: LatestTelemetry | null;
}

export type CommandType = "RETURN_HOME" | "REBOOT";
export type CommandStatus =
  | "PENDING"
  | "SENT"
  | "ACKNOWLEDGED"
  | "FAILED"
  | "TIMED_OUT";

export interface CommandResponse {
  commandId: string;
  deviceId: string;
  type: CommandType;
  status: CommandStatus;
  createdAt: string;
  sentAt: string | null;
}

export interface CommandHistoryItem extends CommandResponse {
  acknowledgementReceivedAt: string | null;
  timedOutAt: string | null;
}

export function normalizeApiBaseUrl(value: string | undefined): string | null {
  const normalized = value?.trim().replace(/\/+$/, "");
  return normalized === undefined || normalized.length === 0
    ? null
    : normalized;
}

export async function fetchDevices(
  apiBaseUrl: string,
  signal?: AbortSignal,
): Promise<DeviceListItem[]> {
  const response = await fetch(`${apiBaseUrl}/devices`, {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    throw new ApiError(response.status);
  }
  const input: unknown = await response.json();
  if (!Array.isArray(input) || !input.every(isDeviceListItem)) {
    throw new TypeError("device list response has an invalid format");
  }
  return input;
}

export async function fetchDevice(
  apiBaseUrl: string,
  deviceId: string,
  signal?: AbortSignal,
): Promise<DeviceDetail> {
  const response = await fetch(
    `${apiBaseUrl}/devices/${encodeURIComponent(deviceId)}`,
    { headers: { Accept: "application/json" }, signal },
  );
  if (!response.ok) {
    throw new ApiError(response.status);
  }
  const input: unknown = await response.json();
  if (!isDeviceDetail(input)) {
    throw new TypeError("device detail response has an invalid format");
  }
  return input;
}

export async function sendCommand(
  apiBaseUrl: string,
  deviceId: string,
  type: CommandType,
): Promise<CommandResponse> {
  const response = await fetch(
    `${apiBaseUrl}/devices/${encodeURIComponent(deviceId)}/commands`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type }),
    },
  );
  if (!response.ok) {
    throw new ApiError(response.status);
  }
  const input: unknown = await response.json();
  if (!isCommandResponse(input)) {
    throw new TypeError("command response has an invalid format");
  }
  return input;
}

export async function fetchCommandHistory(
  apiBaseUrl: string,
  deviceId: string,
  signal?: AbortSignal,
): Promise<CommandHistoryItem[]> {
  const response = await fetch(
    `${apiBaseUrl}/devices/${encodeURIComponent(deviceId)}/commands`,
    { headers: { Accept: "application/json" }, signal },
  );
  if (!response.ok) {
    throw new ApiError(response.status);
  }
  const input: unknown = await response.json();
  if (!Array.isArray(input) || !input.every(isCommandHistoryItem)) {
    throw new TypeError("command history response has an invalid format");
  }
  return input;
}

function isDeviceListItem(input: unknown): input is DeviceListItem {
  if (typeof input !== "object" || input === null) {
    return false;
  }
  const item = input as Record<string, unknown>;
  return (
    typeof item.deviceId === "string" &&
    (item.connectionStatus === "ONLINE" ||
      item.connectionStatus === "OFFLINE") &&
    (item.battery === null || typeof item.battery === "number") &&
    (item.flightStatus === null ||
      item.flightStatus === "IDLE" ||
      item.flightStatus === "FLYING" ||
      item.flightStatus === "RETURNING_HOME") &&
    (item.lastReceivedAt === null || typeof item.lastReceivedAt === "string")
  );
}

function isDeviceDetail(input: unknown): input is DeviceDetail {
  if (typeof input !== "object" || input === null) {
    return false;
  }
  const item = input as Record<string, unknown>;
  return (
    typeof item.deviceId === "string" &&
    (item.model === null || typeof item.model === "string") &&
    (item.softwareVersion === null ||
      typeof item.softwareVersion === "string") &&
    (item.connectionStatus === "ONLINE" ||
      item.connectionStatus === "OFFLINE") &&
    (item.lastReceivedAt === null || typeof item.lastReceivedAt === "string") &&
    typeof item.createdAt === "string" &&
    typeof item.updatedAt === "string" &&
    (item.latestTelemetry === null || isLatestTelemetry(item.latestTelemetry))
  );
}

function isLatestTelemetry(input: unknown): input is LatestTelemetry {
  if (typeof input !== "object" || input === null) {
    return false;
  }
  const telemetry = input as Record<string, unknown>;
  return (
    typeof telemetry.sequence === "number" &&
    typeof telemetry.deviceTimestamp === "string" &&
    typeof telemetry.receivedAt === "string" &&
    typeof telemetry.battery === "number" &&
    typeof telemetry.latitude === "number" &&
    typeof telemetry.longitude === "number" &&
    typeof telemetry.altitude === "number" &&
    typeof telemetry.temperature === "number" &&
    (telemetry.flightStatus === "IDLE" ||
      telemetry.flightStatus === "FLYING" ||
      telemetry.flightStatus === "RETURNING_HOME")
  );
}

function isCommandResponse(input: unknown): input is CommandResponse {
  if (typeof input !== "object" || input === null) {
    return false;
  }
  const command = input as Record<string, unknown>;
  return (
    typeof command.commandId === "string" &&
    typeof command.deviceId === "string" &&
    (command.type === "RETURN_HOME" || command.type === "REBOOT") &&
    (command.status === "PENDING" ||
      command.status === "SENT" ||
      command.status === "ACKNOWLEDGED" ||
      command.status === "FAILED" ||
      command.status === "TIMED_OUT") &&
    typeof command.createdAt === "string" &&
    (command.sentAt === null || typeof command.sentAt === "string")
  );
}

function isCommandHistoryItem(input: unknown): input is CommandHistoryItem {
  if (!isCommandResponse(input)) {
    return false;
  }
  const command = input as unknown as Record<string, unknown>;
  return (
    (command.acknowledgementReceivedAt === null ||
      typeof command.acknowledgementReceivedAt === "string") &&
    (command.timedOutAt === null || typeof command.timedOutAt === "string")
  );
}

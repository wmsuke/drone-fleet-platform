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

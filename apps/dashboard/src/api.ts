export class ApiError extends Error {
  constructor(public readonly status: number) {
    super(`API request failed with status ${status}`);
  }
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
): Promise<unknown> {
  const response = await fetch(`${apiBaseUrl}/devices`, {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    throw new ApiError(response.status);
  }
  return response.json();
}

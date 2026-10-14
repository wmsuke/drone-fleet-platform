import { ApiError } from "./api.js";

export interface Group {
  groupId: string;
  name: string;
  description: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  deviceCount: number;
  deviceIds: string[];
}
function isGroup(value: unknown): value is Group {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.groupId === "string" &&
    typeof item.name === "string" &&
    (item.description === null || typeof item.description === "string") &&
    typeof item.revision === "number" &&
    Number.isSafeInteger(item.revision) &&
    item.revision > 0 &&
    typeof item.createdAt === "string" &&
    Number.isFinite(Date.parse(item.createdAt)) &&
    typeof item.updatedAt === "string" &&
    Number.isFinite(Date.parse(item.updatedAt)) &&
    Array.isArray(item.deviceIds) &&
    item.deviceIds.every((id) => typeof id === "string") &&
    new Set(item.deviceIds).size === item.deviceIds.length &&
    item.deviceCount === item.deviceIds.length
  );
}
async function request(
  base: string,
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers:
      body === undefined
        ? { Accept: "application/json" }
        : { Accept: "application/json", "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });
  if (!response.ok) throw new ApiError(response.status);
  return response.status === 204 ? undefined : response.json();
}
function group(value: unknown): Group {
  if (!isGroup(value))
    throw new TypeError("group response has an invalid format");
  return value;
}
export async function fetchGroups(
  base: string,
  signal?: AbortSignal,
): Promise<Group[]> {
  const value = await request(base, "/groups", "GET", undefined, signal);
  if (!Array.isArray(value) || !value.every(isGroup))
    throw new TypeError("group list response has an invalid format");
  return value;
}
export async function fetchGroup(
  base: string,
  id: string,
  signal?: AbortSignal,
): Promise<Group> {
  return group(
    await request(
      base,
      `/groups/${encodeURIComponent(id)}`,
      "GET",
      undefined,
      signal,
    ),
  );
}
export type GroupAction =
  | { type: "create"; name: string }
  | { type: "rename"; groupId: string; name: string }
  | { type: "delete"; groupId: string; name: string }
  | { type: "add" | "remove"; groupId: string; deviceId: string };
export async function mutateGroup(
  base: string,
  action: GroupAction,
): Promise<void> {
  if (action.type === "create") {
    group(await request(base, "/groups", "POST", { name: action.name }));
    return;
  }
  const path = `/groups/${encodeURIComponent(action.groupId)}`;
  if (action.type === "rename") {
    group(await request(base, path, "PATCH", { name: action.name }));
    return;
  }
  if (action.type === "delete") {
    await request(base, path, "DELETE");
    return;
  }
  if (action.type === "add") {
    group(
      await request(base, `${path}/devices`, "POST", {
        deviceId: action.deviceId,
      }),
    );
    return;
  }
  await request(
    base,
    `${path}/devices/${encodeURIComponent(action.deviceId)}`,
    "DELETE",
  );
}

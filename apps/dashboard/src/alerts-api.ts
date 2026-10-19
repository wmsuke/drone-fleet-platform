import { ApiError } from "./api.js";
export interface AlertItem {
  alertId: string;
  deviceId: string;
  commandId: string | null;
  kind: "OFFLINE" | "LOW_BATTERY" | "COMMAND_OUTCOME";
  status: "ACTIVE" | "RESOLVED";
  severity: "warning";
  reason: string;
  occurredAt: string;
  lastObservedAt: string;
  resolvedAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedActorKind: string | null;
  acknowledgedActorId: string | null;
  relatedGroups: { groupId: string; name: string }[];
  operationId: string | null;
}
export interface AlertPage {
  items: AlertItem[];
  total: number;
  limit: number;
  offset: number;
}
function record(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function date(v: unknown) {
  return typeof v === "string" && Number.isFinite(Date.parse(v));
}
function nullableString(v: unknown) {
  return v === null || typeof v === "string";
}
const uuid = (v: unknown) =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v,
  );
function valid(v: unknown): v is AlertItem {
  return (
    record(v) &&
    uuid(v.alertId) &&
    typeof v.deviceId === "string" &&
    (v.commandId === null || uuid(v.commandId)) &&
    typeof v.kind === "string" &&
    ["OFFLINE", "LOW_BATTERY", "COMMAND_OUTCOME"].includes(v.kind) &&
    typeof v.status === "string" &&
    ["ACTIVE", "RESOLVED"].includes(v.status) &&
    (v.status === "ACTIVE" ? v.resolvedAt === null : date(v.resolvedAt)) &&
    (v.kind === "COMMAND_OUTCOME"
      ? v.commandId !== null
      : v.commandId === null) &&
    v.severity === "warning" &&
    typeof v.reason === "string" &&
    date(v.occurredAt) &&
    date(v.lastObservedAt) &&
    (v.resolvedAt === null || date(v.resolvedAt)) &&
    (v.acknowledgedAt === null || date(v.acknowledgedAt)) &&
    nullableString(v.acknowledgedActorKind) &&
    nullableString(v.acknowledgedActorId) &&
    (v.operationId === null || uuid(v.operationId)) &&
    Array.isArray(v.relatedGroups) &&
    v.relatedGroups.every(
      (g) => record(g) && uuid(g.groupId) && typeof g.name === "string",
    )
  );
}
export async function alertRequest(
  base: string,
  path: string,
  signal?: AbortSignal,
  method = "GET",
): Promise<unknown> {
  const response = await fetch(`${base}${path}`, {
    method,
    signal: signal ?? AbortSignal.timeout(15000),
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new ApiError(response.status);
  return response.json();
}
export async function fetchAlert(
  base: string,
  id: string,
  signal?: AbortSignal,
  ack = false,
): Promise<AlertItem> {
  const value = await alertRequest(
    base,
    `/alerts/${encodeURIComponent(id)}${ack ? "/acknowledge" : ""}`,
    signal,
    ack ? "POST" : "GET",
  );
  if (!valid(value)) throw new TypeError("alertの応答が不正です");
  return value;
}
export async function fetchAlerts(
  base: string,
  query: string,
  signal?: AbortSignal,
): Promise<AlertPage> {
  const v = await alertRequest(base, `/alerts?${query}`, signal);
  if (
    !record(v) ||
    !Array.isArray(v.items) ||
    !v.items.every(valid) ||
    !Number.isSafeInteger(v.total) ||
    Number(v.total) < 0 ||
    !Number.isSafeInteger(v.limit) ||
    Number(v.limit) < 1 ||
    Number(v.limit) > 100 ||
    !Number.isSafeInteger(v.offset) ||
    Number(v.offset) < 0 ||
    v.items.length > Number(v.limit)
  )
    throw new TypeError("alert一覧の応答が不正です");
  return v as unknown as AlertPage;
}

import { ApiError } from "./api.js";
export const auditActions = [
  "deployment.recovery_requested",
  "deployment.recovery_changed",
  "deployment.approved",
  "deployment.stopped",
  "deployment.resumed",
  "deployment.accepted",
  "deployment.replayed",
  "release.registered",
  "group.created",
  "group.updated",
  "group.deleted",
  "membership.added",
  "membership.removed",
  "command.accepted",
  "operation.accepted",
  "operation.replayed",
  "alert.acknowledged",
  "command.acknowledged",
  "command.expired",
  "command.execution_changed",
  "command.conflict",
  "alert.raised",
  "alert.resolved",
  "alert.reason_changed",
  "operation.status_changed",
] as const;
export const metadataLabels = {
  beforeName: "変更前の名前",
  afterName: "変更後の名前",
  descriptionChanged: "説明の変更",
  memberDeviceId: "所属変更の機体",
  commandType: "command種別",
  targetCount: "対象台数",
  beforeStatus: "変更前の状態",
  afterStatus: "変更後の状態",
  beforeReason: "変更前の理由",
  reason: "理由コード",
  statusCode: "HTTP status",
};
export interface AuditItem {
  eventId: string;
  schemaVersion: 1;
  occurredAt: string;
  actorKind: "anonymous" | "system";
  actorId: string | null;
  action: (typeof auditActions)[number];
  targetKind:
    | "group"
    | "device"
    | "command"
    | "operation"
    | "alert"
    | "release"
    | "deployment";
  targetId: string | null;
  result: "SUCCEEDED" | "REJECTED" | "FAILED";
  requestId: string | null;
  groupId: string | null;
  operationId: string | null;
  commandId: string | null;
  alertId: string | null;
  deviceId: string | null;
  metadata: Partial<
    Record<keyof typeof metadataLabels, string | number | boolean | null>
  >;
}
export interface AuditPage {
  items: AuditItem[];
  limit: number;
  nextCursor: string | null;
}
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const uuid = (v: unknown) =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v,
  );
const device = (v: unknown) =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);
function metadata(v: unknown) {
  if (!record(v)) return false;
  return Object.entries(v).every(([key, value]) => {
    if (!Object.hasOwn(metadataLabels, key)) return false;
    if (key === "beforeName" || key === "afterName")
      return typeof value === "string" && value.length <= 100;
    if (key === "descriptionChanged") return typeof value === "boolean";
    if (key === "memberDeviceId") return device(value);
    if (key === "targetCount" || key === "statusCode")
      return (
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      );
    return (
      (key === "beforeStatus" && value === null) ||
      (typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value))
    );
  });
}
function valid(v: unknown): v is AuditItem {
  return (
    record(v) &&
    uuid(v.eventId) &&
    v.schemaVersion === 1 &&
    typeof v.occurredAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(v.occurredAt) &&
    Number.isFinite(Date.parse(v.occurredAt)) &&
    (v.actorKind === "anonymous"
      ? v.actorId === null
      : v.actorKind === "system" &&
        typeof v.actorId === "string" &&
        [
          "telemetry-ingestor",
          "alert-evaluator",
          "operation-evaluator",
          "ota-worker",
        ].includes(v.actorId)) &&
    typeof v.action === "string" &&
    auditActions.some((a) => a === v.action) &&
    typeof v.targetKind === "string" &&
    [
      "group",
      "device",
      "command",
      "operation",
      "alert",
      "release",
      "deployment",
    ].includes(v.targetKind) &&
    (v.targetId === null ||
      (typeof v.targetId === "string" &&
        /^[A-Za-z0-9_-]{1,128}$/.test(v.targetId))) &&
    typeof v.result === "string" &&
    ["SUCCEEDED", "REJECTED", "FAILED"].includes(v.result) &&
    [v.requestId, v.groupId, v.operationId, v.commandId, v.alertId].every(
      (id) => id === null || uuid(id),
    ) &&
    (v.deviceId === null || device(v.deviceId)) &&
    metadata(v.metadata)
  );
}
async function request(
  base: string,
  path: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch(base + path, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new ApiError(response.status);
  return response.json();
}
export async function fetchAuditPage(
  base: string,
  query: string,
  signal?: AbortSignal,
): Promise<AuditPage> {
  const v = await request(base + "/audit-logs", `?${query}`, signal);
  if (
    !record(v) ||
    !Array.isArray(v.items) ||
    !v.items.every(valid) ||
    !Number.isSafeInteger(v.limit) ||
    Number(v.limit) < 1 ||
    Number(v.limit) > 100 ||
    v.items.length > Number(v.limit) ||
    (v.nextCursor !== null &&
      (typeof v.nextCursor !== "string" ||
        v.nextCursor.length > 512 ||
        !/^[A-Za-z0-9_-]+$/.test(v.nextCursor)))
  )
    throw new TypeError("audit一覧の応答が不正です");
  return v as unknown as AuditPage;
}
export async function fetchAudit(
  base: string,
  id: string,
  signal?: AbortSignal,
): Promise<AuditItem> {
  const v = await request(
    base,
    `/audit-logs/${encodeURIComponent(id)}`,
    signal,
  );
  if (!valid(v)) throw new TypeError("auditの応答が不正です");
  return v;
}

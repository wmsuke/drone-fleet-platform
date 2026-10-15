import { ApiError, type CommandType } from "./api.js";

export const operationLabels = {
  ACCEPTED: "受付済み",
  IN_PROGRESS: "進行中",
  COMPLETED: "全件完了",
  PARTIALLY_FAILED: "一部不成功",
  FAILED: "全件不成功",
} as const;
export const targetLabels = {
  PENDING: "送信待ち",
  SENT: "送信済み・受領待ち",
  ACKNOWLEDGED: "受領済み・結果待ち",
  RUNNING: "実行中",
  SUCCEEDED: "完了",
  EXECUTION_FAILED: "実行失敗",
  DELIVERY_FAILED: "送信失敗",
  EXPIRED: "開始期限切れ",
  UNRESPONSIVE: "未応答",
  UNCERTAIN: "結果不明",
} as const;
export type TargetStatus = keyof typeof targetLabels;
export type OperationStatus = keyof typeof operationLabels;
export interface OperationAccepted {
  operationId: string;
  groupId: string;
  type: CommandType;
  status: "ACCEPTED";
  targetCount: number;
  createdAt: string;
  expiresAt: string;
  resultDeadline: string;
}
export interface OperationSummary extends Omit<OperationAccepted, "status"> {
  groupName: string;
  groupRevision: number;
  status: OperationStatus;
  counts: Record<TargetStatus, number>;
  succeededCount: number;
  unsuccessfulCount: number;
  inProgressCount: number;
  acknowledgedCount: number;
  updatedAt: string;
}
export interface OperationTarget {
  deviceId: string;
  commandId: string;
  status: TargetStatus;
  commandStatus: string;
  executionStatus: string;
  outboxState: string | null;
  attempts: number;
  failures: number;
  sentAt: string | null;
  acknowledgementReceivedAt: string | null;
  executionStartedAt: string | null;
  executionStartedReceivedAt: string | null;
  executionResultAt: string | null;
  executionResultReceivedAt: string | null;
  updatedAt: string;
}
export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
export interface OperationDetail extends OperationSummary {
  evaluatedAt: string;
  targets: Page<OperationTarget>;
}
export interface OperationList extends Page<OperationSummary> {
  evaluatedAt: string;
}
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;
const integer = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const date = (v: unknown): v is string =>
  typeof v === "string" && Number.isFinite(Date.parse(v));
const nullableDate = (v: unknown) => v === null || date(v);
export const isOperationId = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v,
  );
function envelope(v: unknown): v is OperationAccepted {
  return (
    object(v) &&
    isOperationId(v.operationId) &&
    isOperationId(v.groupId) &&
    ["RETURN_HOME", "REBOOT"].includes(v.type as string) &&
    integer(v.targetCount) &&
    v.targetCount > 0 &&
    date(v.createdAt) &&
    date(v.expiresAt) &&
    date(v.resultDeadline)
  );
}
function summary(v: unknown): v is OperationSummary {
  if (!envelope(v) || !object(v)) return false;
  const c = v.counts;
  if (!object(c) || !Object.keys(targetLabels).every((s) => integer(c[s])))
    return false;
  const counts = c as Record<TargetStatus, number>;
  return (
    typeof v.groupName === "string" &&
    integer(v.groupRevision) &&
    v.groupRevision > 0 &&
    Object.hasOwn(operationLabels, v.status as string) &&
    date(v.updatedAt) &&
    Object.values(counts).reduce((sum, n) => sum + n, 0) === v.targetCount &&
    v.succeededCount === counts.SUCCEEDED &&
    v.inProgressCount ===
      counts.PENDING + counts.SENT + counts.ACKNOWLEDGED + counts.RUNNING &&
    integer(v.unsuccessfulCount) &&
    v.unsuccessfulCount +
      (v.succeededCount as number) +
      (v.inProgressCount as number) ===
      v.targetCount &&
    integer(v.acknowledgedCount) &&
    v.acknowledgedCount <= v.targetCount
  );
}
function target(v: unknown): v is OperationTarget {
  return (
    object(v) &&
    typeof v.deviceId === "string" &&
    /^[A-Za-z0-9_-]{1,64}$/.test(v.deviceId) &&
    isOperationId(v.commandId) &&
    Object.hasOwn(targetLabels, v.status as string) &&
    [
      "PENDING",
      "SENT",
      "ACKNOWLEDGED",
      "FAILED",
      "TIMED_OUT",
      "EXPIRED",
    ].includes(v.commandStatus as string) &&
    ["NOT_REPORTED", "RUNNING", "SUCCEEDED", "FAILED", "UNCERTAIN"].includes(
      v.executionStatus as string,
    ) &&
    (v.outboxState === null ||
      [
        "PENDING",
        "WAITING_ACK",
        "ACKNOWLEDGED",
        "FAILED",
        "TIMED_OUT",
        "EXPIRED",
      ].includes(v.outboxState as string)) &&
    integer(v.attempts) &&
    integer(v.failures) &&
    v.failures <= v.attempts &&
    date(v.updatedAt) &&
    [
      "sentAt",
      "acknowledgementReceivedAt",
      "executionStartedAt",
      "executionStartedReceivedAt",
      "executionResultAt",
      "executionResultReceivedAt",
    ].every((key) => nullableDate(v[key]))
  );
}
function page<T>(v: unknown, check: (x: unknown) => x is T): v is Page<T> {
  return (
    object(v) &&
    Array.isArray(v.items) &&
    v.items.every(check) &&
    integer(v.total) &&
    integer(v.limit) &&
    v.limit > 0 &&
    v.limit <= 100 &&
    integer(v.offset) &&
    v.items.length <= v.limit &&
    v.items.length <= Math.max(0, v.total - v.offset)
  );
}
async function request(base: string, path: string, signal?: AbortSignal) {
  const res = await fetch(`${base}${path}`, {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<unknown>;
}
export async function fetchOperations(
  base: string,
  query: { groupId?: string; status?: OperationStatus; offset?: number } = {},
  signal?: AbortSignal,
): Promise<OperationList> {
  const params = new URLSearchParams({
    limit: "20",
    offset: String(query.offset ?? 0),
  });
  if (query.groupId) params.set("groupId", query.groupId);
  if (query.status) params.set("status", query.status);
  const v = await request(base, `/fleet-operations?${params}`, signal);
  if (!page(v, summary) || !object(v) || !date(v.evaluatedAt))
    throw new TypeError("invalid operation list");
  return { ...v, evaluatedAt: v.evaluatedAt };
}
export async function fetchOperation(
  base: string,
  id: string,
  query: { status?: TargetStatus; offset: number },
  signal?: AbortSignal,
): Promise<OperationDetail> {
  const params = new URLSearchParams({
    limit: "25",
    offset: String(query.offset),
  });
  if (query.status) params.set("status", query.status);
  const v = await request(
    base,
    `/fleet-operations/${encodeURIComponent(id)}?${params}`,
    signal,
  );
  if (
    !summary(v) ||
    !object(v) ||
    !date(v.evaluatedAt) ||
    !page(v.targets, target) ||
    v.operationId !== id.toLowerCase()
  )
    throw new TypeError("invalid operation detail");
  return v as unknown as OperationDetail;
}
export async function sendOperation(
  base: string,
  request: { groupId: string; type: CommandType; key: string },
): Promise<OperationAccepted> {
  const res = await fetch(`${base}/fleet-operations`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Idempotency-Key": request.key,
    },
    body: JSON.stringify({ groupId: request.groupId, type: request.type }),
  });
  if (!res.ok) throw new ApiError(res.status);
  const v: unknown = await res.json();
  if (
    res.status !== 202 ||
    !envelope(v) ||
    v.status !== "ACCEPTED" ||
    v.groupId !== request.groupId ||
    v.type !== request.type
  )
    throw new TypeError("invalid operation receipt");
  return v;
}

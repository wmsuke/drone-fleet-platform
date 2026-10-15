import type {
  OperationAccepted,
  OperationDetail,
  TargetStatus,
  OperationTarget,
} from "../src/fleet-operations-api.js";
import type { Group } from "../src/groups-api.js";
export const groupId = "c1eaa546-9ff8-4b7b-8f9a-b8c0739d6b55";
export const operationId = "6957ca77-f1d7-4598-863a-28faf7496f62";
export const stamp = "2026-10-15T00:00:00.000Z";
export function group(): Group {
  return {
    groupId,
    name: "訓練隊",
    revision: 1,
    deviceCount: 3,
    deviceIds: ["drone-001", "drone-002", "drone-003"],
    description: null,
    createdAt: stamp,
    updatedAt: stamp,
  };
}
export function devices() {
  return ["drone-001", "drone-002", "drone-003"].map((deviceId, i) => ({
    deviceId,
    connectionStatus: i ? "OFFLINE" : "ONLINE",
    battery: null,
    flightStatus: null,
    lastReceivedAt: null,
  }));
}
export function target(status: TargetStatus, i = 0): OperationTarget {
  return {
    deviceId: `drone-${String(i + 1).padStart(3, "0")}`,
    commandId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    status,
    commandStatus: status === "ACKNOWLEDGED" ? "ACKNOWLEDGED" : "SENT",
    executionStatus: status === "SUCCEEDED" ? "SUCCEEDED" : "NOT_REPORTED",
    outboxState: "WAITING_ACK",
    attempts: 1,
    failures: 0,
    sentAt: stamp,
    acknowledgementReceivedAt: status === "ACKNOWLEDGED" ? stamp : null,
    executionStartedAt: null,
    executionStartedReceivedAt: null,
    executionResultAt: null,
    executionResultReceivedAt: null,
    updatedAt: stamp,
  };
}
export function detail(
  statuses: TargetStatus[] = ["SUCCEEDED", "UNRESPONSIVE", "EXPIRED"],
): OperationDetail {
  const counts = {
    PENDING: 0,
    SENT: 0,
    ACKNOWLEDGED: 0,
    RUNNING: 0,
    SUCCEEDED: 0,
    EXECUTION_FAILED: 0,
    DELIVERY_FAILED: 0,
    EXPIRED: 0,
    UNRESPONSIVE: 0,
    UNCERTAIN: 0,
  };
  statuses.forEach((s) => counts[s]++);
  const progress =
    counts.PENDING + counts.SENT + counts.ACKNOWLEDGED + counts.RUNNING;
  return {
    operationId,
    groupId,
    groupName: "受付時の訓練隊",
    groupRevision: 1,
    type: "RETURN_HOME",
    targetCount: statuses.length,
    createdAt: stamp,
    expiresAt: "2026-10-15T00:00:30.000Z",
    resultDeadline: "2026-10-15T00:02:00.000Z",
    evaluatedAt: "2026-10-15T00:02:00.000Z",
    updatedAt: stamp,
    status:
      counts.PENDING === statuses.length
        ? "ACCEPTED"
        : progress
          ? "IN_PROGRESS"
          : counts.SUCCEEDED === statuses.length
            ? "COMPLETED"
            : counts.SUCCEEDED
              ? "PARTIALLY_FAILED"
              : "FAILED",
    counts,
    succeededCount: counts.SUCCEEDED,
    inProgressCount: progress,
    unsuccessfulCount: statuses.length - progress - counts.SUCCEEDED,
    acknowledgedCount: counts.ACKNOWLEDGED,
    targets: {
      items: statuses.slice(0, 25).map(target),
      limit: 25,
      offset: 0,
      total: statuses.length,
    },
  };
}
export function accepted(): OperationAccepted {
  const d = detail();
  return {
    operationId,
    groupId,
    type: d.type,
    targetCount: d.targetCount,
    status: "ACCEPTED",
    createdAt: stamp,
    expiresAt: d.expiresAt,
    resultDeadline: d.resultDeadline,
  };
}
export function list(items = [detail()]) {
  return {
    items,
    total: items.length,
    limit: 20,
    offset: 0,
    evaluatedAt: stamp,
  };
}
export function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}

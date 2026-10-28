import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { isValidDeviceId } from "@drone-fleet/protocol";
import {
  appendAudit,
  auditContext,
  type AuditEvent,
  type Database,
} from "@drone-fleet/database";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function id(value: unknown) {
  return typeof value === "string" && uuid.test(value)
    ? value.toLowerCase()
    : null;
}
const routes: Record<string, [AuditEvent["action"], AuditEvent["targetKind"]]> =
  {
    "POST /releases": ["release.registered", "release"],
    "POST /deployments": ["deployment.accepted", "deployment"],
    "POST /deployments/:deploymentId/stages/:stageId/approve": [
      "deployment.approved",
      "deployment",
    ],
    "POST /deployments/:deploymentId/stop": [
      "deployment.stopped",
      "deployment",
    ],
    "POST /deployments/:deploymentId/resume": [
      "deployment.resumed",
      "deployment",
    ],
    "POST /groups": ["group.created", "group"],
    "PATCH /groups/:groupId": ["group.updated", "group"],
    "DELETE /groups/:groupId": ["group.deleted", "group"],
    "POST /groups/:groupId/devices": ["membership.added", "group"],
    "DELETE /groups/:groupId/devices/:deviceId": [
      "membership.removed",
      "group",
    ],
    "POST /devices/:deviceId/commands": ["command.accepted", "device"],
    "POST /fleet-operations": ["operation.accepted", "operation"],
    "POST /alerts/:alertId/acknowledge": ["alert.acknowledged", "alert"],
  };
export function registerAuditHooks(app: FastifyInstance, db: Database) {
  let failures = 0;
  app.addHook("onRequest", (request, reply, done) => {
    // クライアントのrequest-id/actor headerは採用しない。
    const requestId = randomUUID();
    request.id = requestId;
    reply.header("X-Request-Id", requestId);
    auditContext.run({ requestId }, done);
  });
  app.addHook("onSend", async (request, reply, payload) => {
    const event = routes[`${request.method} ${request.routeOptions.url}`];
    if (!event || reply.statusCode < 400) return payload;
    const params = request.params as Record<string, unknown>;
    const body =
      typeof request.body === "object" && request.body !== null
        ? (request.body as Record<string, unknown>)
        : {};
    const groupId = id(params.groupId) ?? id(body.groupId);
    const alertId = id(params.alertId);
    const deviceId =
      typeof params.deviceId === "string" && isValidDeviceId(params.deviceId)
        ? params.deviceId
        : null;
    const [action, targetKind] = event;
    try {
      await appendAudit(db, {
        action,
        targetKind,
        targetId:
          targetKind === "group"
            ? groupId
            : targetKind === "alert"
              ? alertId
              : targetKind === "device"
                ? deviceId
                : targetKind === "deployment"
                  ? id(params.deploymentId)
                  : null,
        groupId,
        alertId,
        requestId: request.id,
        result: reply.statusCode >= 500 ? "FAILED" : "REJECTED",
        metadata: {
          statusCode: reply.statusCode,
          reason:
            auditContext.getStore()?.rejectionReason ??
            (reply.statusCode >= 500
              ? "INTERNAL_ERROR"
              : reply.statusCode === 404
                ? "TARGET_NOT_FOUND"
                : reply.statusCode === 409
                  ? "CONFLICT"
                  : "INVALID_INPUT"),
        },
      });
    } catch {
      failures++;
      try {
        console.error(
          JSON.stringify({
            event: "audit.write_failed",
            requestId: request.id,
            action,
            failures,
          }),
        );
      } catch {
        /* 診断出力の失敗でも元のHTTPエラーを維持する */
      }
    }
    return payload;
  });
}

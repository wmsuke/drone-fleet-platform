import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  commands,
  commandOutbox,
  groups,
  groupMemberships,
  fleetOperations,
  fleetOperationTargets,
  appendAudit,
  appendAudits,
  operationAuditStates,
  type Database,
} from "@drone-fleet/database";
import {
  commandV2MessageSchema,
  createCommandsTopic,
} from "@drone-fleet/protocol";
import type {
  FleetOperationRequest,
  FleetOperationResponse,
  OperationListQuery,
  OperationListResponse,
  OperationTargetQuery,
  OperationDetailResponse,
} from "./fleet-operation-schema.js";
import { createFleetOperationQueries } from "./fleet-operation-query.js";

export class FleetOperationError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409,
    message: string,
    public readonly reason = "OPERATION_REJECTED",
  ) {
    super(message);
  }
}
export interface FleetOperationRepository {
  list(query: OperationListQuery): Promise<OperationListResponse>;
  find(
    operationId: string,
    query: OperationTargetQuery,
  ): Promise<OperationDetailResponse | null>;
  create(
    request: FleetOperationRequest,
    key: string,
  ): Promise<FleetOperationResponse>;
}
export function loadFleetOperationOptions(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const maxTargets = Number(environment.FLEET_OPERATION_MAX_TARGETS ?? 100);
  if (!Number.isSafeInteger(maxTargets) || maxTargets < 1 || maxTargets > 1000)
    throw new TypeError(
      "FLEET_OPERATION_MAX_TARGETS must be an integer between 1 and 1000",
    );
  return { maxTargets };
}
function response(
  row: typeof fleetOperations.$inferSelect,
): FleetOperationResponse {
  return {
    operationId: row.operationId,
    groupId: row.groupId,
    type: row.type,
    status: "ACCEPTED",
    targetCount: row.targetCount,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    resultDeadline: row.resultDeadline.toISOString(),
  };
}
export function createFleetOperationRepository(
  db: Database,
  options: {
    maxTargets: number;
    clock?: () => Date;
    onAccepted?: (metrics: {
      targetCount: number;
      durationMs: number;
      replayed: boolean;
    }) => void;
  } = { maxTargets: 100 },
): FleetOperationRepository {
  if (
    !Number.isSafeInteger(options.maxTargets) ||
    options.maxTargets < 1 ||
    options.maxTargets > 1000
  )
    throw new TypeError("maxTargets must be between 1 and 1000");
  return {
    ...createFleetOperationQueries(db, options.clock ?? (() => new Date())),
    async create(request, key) {
      const start = performance.now();
      let replayed = false;
      const result = await db.transaction(async (tx) => {
        const scope = "anonymous";
        // 同じkeyを先に直列化する。hash衝突は待機を増やすだけで、正本の照合には使わない。
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${scope + ":" + key}, 0))`,
        );
        const [existing] = await tx
          .select()
          .from(fleetOperations)
          .where(
            and(
              eq(fleetOperations.idempotencyScope, scope),
              eq(fleetOperations.idempotencyKey, key),
            ),
          );
        if (existing) {
          if (
            existing.groupId !== request.groupId ||
            existing.type !== request.type
          )
            throw new FleetOperationError(
              409,
              "同じkeyで異なる要求は受け付けられません",
              "IDEMPOTENCY_CONFLICT",
            );
          replayed = true;
          await appendAudit(tx, {
            action: "operation.replayed",
            targetKind: "operation",
            targetId: existing.operationId,
            operationId: existing.operationId,
            groupId: existing.groupId,
            metadata: {
              commandType: existing.type,
              targetCount: existing.targetCount,
            },
          });
          return response(existing);
        }
        const [group] = await tx
          .select()
          .from(groups)
          .where(eq(groups.groupId, request.groupId))
          .for("update");
        if (!group)
          throw new FleetOperationError(
            404,
            "groupが見つかりません",
            "GROUP_NOT_FOUND",
          );
        if (group.deletedAt)
          throw new FleetOperationError(
            409,
            "groupは削除されています",
            "GROUP_DELETED",
          );
        const members = await tx
          .select({ deviceId: groupMemberships.deviceId })
          .from(groupMemberships)
          .where(eq(groupMemberships.groupId, request.groupId))
          .orderBy(asc(groupMemberships.deviceId))
          .limit(options.maxTargets + 1);
        if (members.length === 0)
          throw new FleetOperationError(
            409,
            "空groupには送信できません",
            "GROUP_EMPTY",
          );
        if (members.length > options.maxTargets)
          throw new FleetOperationError(
            400,
            "対象数上限を超えています",
            "TARGET_LIMIT_EXCEEDED",
          );
        const createdAt = new Date(),
          expiresAt = new Date(createdAt.getTime() + 30_000),
          resultDeadline = new Date(createdAt.getTime() + 120_000);
        const operationId = randomUUID();
        const [operation] = await tx
          .insert(fleetOperations)
          .values({
            operationId,
            groupId: group.groupId,
            groupName: group.name,
            groupRevision: group.revision,
            type: request.type,
            idempotencyScope: scope,
            idempotencyKey: key,
            targetCount: members.length,
            createdAt,
            expiresAt,
            resultDeadline,
          })
          .returning();
        if (!operation) throw new Error("operation insert returned no row");
        const pending = members.map(({ deviceId }) => ({
          commandId: randomUUID(),
          deviceId,
          type: request.type,
          status: "PENDING" as const,
          createdAt,
          expiresAt,
        }));
        await tx.insert(commands).values(pending);
        await tx.insert(commandOutbox).values(
          pending.map((command) => ({
            commandId: command.commandId,
            topic: createCommandsTopic(command.deviceId),
            payload: JSON.stringify(
              commandV2MessageSchema.parse({
                schemaVersion: 2,
                commandId: command.commandId,
                deviceId: command.deviceId,
                type: command.type,
                timestamp: createdAt.toISOString(),
                expiresAt: expiresAt.toISOString(),
              }),
            ),
            createdAt,
            expiresAt,
            nextAttemptAt: createdAt,
          })),
        );
        await tx.insert(fleetOperationTargets).values(
          pending.map(({ deviceId, commandId }) => ({
            operationId,
            deviceId,
            commandId,
          })),
        );
        await appendAudit(tx, {
          action: "operation.accepted",
          targetKind: "operation",
          targetId: operationId,
          groupId: group.groupId,
          operationId,
          metadata: {
            commandType: request.type,
            targetCount: pending.length,
            afterStatus: "ACCEPTED",
          },
        });
        await appendAudits(
          tx,
          pending.map((command) => ({
            action: "command.accepted",
            targetKind: "command",
            targetId: command.commandId,
            groupId: group.groupId,
            operationId,
            commandId: command.commandId,
            metadata: { commandType: command.type },
          })),
        );
        await tx
          .insert(operationAuditStates)
          .values({ operationId, status: "ACCEPTED", evaluatedAt: createdAt });
        return response(operation);
      });
      // 計測出力の失敗でcommit済み受付を失敗に見せない。
      try {
        options.onAccepted?.({
          targetCount: result.targetCount,
          durationMs: performance.now() - start,
          replayed,
        });
      } catch {
        /* DB結果を優先する */
      }
      return result;
    },
  };
}

import { randomUUID, createHash } from "node:crypto";
import { and, eq, lte, asc, sql, inArray, or } from "drizzle-orm";
import {
  bridgeCancelRequestSchema,
  canonicalBridgeJson,
  createBridgeRequestsTopic,
  type BridgeCancelEvent,
} from "@drone-fleet/protocol";
import {
  rosCommandCancels as cancels,
  bridgeCancelEvents as events,
  rosCommandTargets as targets,
  bridgeConfigurations,
  bridgeReports,
  bridgeActionEvents,
  commands,
  devices,
  bridgeConflicts,
} from "./schema.js";
import type { Database } from "./connection.js";
import { appendAudit, auditContext } from "./audit.js";
export class RosCancelError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const hash = (v: unknown) =>
  createHash("sha256").update(canonicalBridgeJson(v)).digest("hex");
export function createRosCancelRepository(db: Database) {
  async function evaluate(now: Date) {
    const pending = await db
      .select()
      .from(cancels)
      .where(
        or(
          inArray(cancels.assessment, ["PENDING", "REJECTED"]),
          sql`EXISTS (SELECT 1 FROM ros_command_targets t WHERE t.command_id=${cancels.commandId} AND t.conflicted AND ${cancels.assessment}<>'UNCERTAIN')`,
        ),
      );
    for (const row of pending)
      await db.transaction(async (tx) => {
        await tx
          .select()
          .from(devices)
          .where(eq(devices.deviceId, row.deviceId))
          .for("update");
        const [current] = await tx
          .select()
          .from(cancels)
          .where(eq(cancels.cancelId, row.cancelId))
          .for("update");
        if (!current || current.assessment === "UNCERTAIN") return;
        const [target] = await tx
          .select()
          .from(targets)
          .where(eq(targets.commandId, row.commandId));
        const [command] = await tx
          .select()
          .from(commands)
          .where(eq(commands.commandId, row.commandId));
        const [stop] = await tx
          .select()
          .from(bridgeActionEvents)
          .where(
            and(
              eq(bridgeActionEvents.commandId, row.commandId),
              eq(bridgeActionEvents.disposition, "APPLIED"),
              sql`${bridgeActionEvents.message}->>'kind'='STOP_OBSERVATION'`,
            ),
          )
          .orderBy(asc(bridgeActionEvents.receivedAt))
          .limit(1);
        let assessment = "PENDING";
        if (target?.conflicted) assessment = "UNCERTAIN";
        else if (
          target?.stopConfirmed &&
          stop &&
          stop.receivedAt < row.expiresAt &&
          command &&
          command.executionResultReceivedAt &&
          command.executionResultReceivedAt < row.expiresAt &&
          ["CANCELLED", "SUCCEEDED", "FAILED"].includes(command.executionStatus)
        )
          assessment =
            command.executionStatus === "SUCCEEDED"
              ? "COMPLETED"
              : command.executionStatus;
        else if (now >= row.expiresAt || current.phase === "UNCERTAIN")
          assessment = "UNCERTAIN";
        else if (current.phase === "REJECTED") assessment = "REJECTED";
        if (assessment !== current.assessment) {
          await tx
            .update(cancels)
            .set({ assessment })
            .where(eq(cancels.cancelId, row.cancelId));
          await appendAudit(tx, {
            action: "command.cancel_changed",
            targetKind: "command",
            targetId: row.commandId,
            commandId: row.commandId,
            system: "cancel-worker",
            metadata: {
              interventionId: row.interventionId,
              beforeStatus: current.assessment,
              afterStatus: assessment,
              reason: "CANCEL_EVALUATED",
            },
          });
        }
      });
  }
  return {
    evaluate,
    async create(
      deviceId: string,
      commandId: string,
      key: string,
      reason: string,
      now = new Date(),
    ) {
      return db.transaction(async (tx) => {
        await tx
          .select()
          .from(devices)
          .where(eq(devices.deviceId, deviceId))
          .for("update");
        const [old] = await tx
          .select()
          .from(cancels)
          .where(eq(cancels.commandId, commandId));
        if (old) {
          if (old.deviceId !== deviceId)
            throw new RosCancelError(404, "COMMAND_NOT_FOUND");
          if (old.key !== key)
            throw new RosCancelError(409, "CANCEL_ALREADY_REQUESTED");
          if (old.request.reason !== reason)
            throw new RosCancelError(409, "IDEMPOTENCY_CONFLICT");
          await appendAudit(tx, {
            action: "command.cancel_replayed",
            targetKind: "command",
            targetId: commandId,
            commandId,
            metadata: { interventionId: old.interventionId, reason },
          });
          return { cancelId: old.cancelId, replayed: true };
        }
        const [command] = await tx
          .select()
          .from(commands)
          .where(
            and(
              eq(commands.commandId, commandId),
              eq(commands.deviceId, deviceId),
            ),
          )
          .for("update");
        const [target] = await tx
          .select()
          .from(targets)
          .where(eq(targets.commandId, commandId))
          .for("update");
        if (!command) throw new RosCancelError(404, "COMMAND_NOT_FOUND");
        if (
          !target?.goalId ||
          !target.acceptedAt ||
          target.conflicted ||
          command.executionStatus === "UNCERTAIN"
        )
          throw new RosCancelError(409, "GOAL_UNCONFIRMED");
        if (!["NOT_REPORTED", "RUNNING"].includes(command.executionStatus))
          throw new RosCancelError(409, "GOAL_ALREADY_TERMINAL");
        const [configuration] = await tx
          .select()
          .from(bridgeConfigurations)
          .where(
            eq(bridgeConfigurations.configurationId, target.configurationId),
          );
        if (
          configuration!.snapshot.bridge.status !== "KNOWN" ||
          configuration!.snapshot.bridge.version !== "0.4.0"
        )
          throw new RosCancelError(409, "ROS_CANCEL_UPGRADE_REQUIRED");
        const cancelId = randomUUID(),
          interventionId = randomUUID(),
          expiresAt = new Date(now.getTime() + 10000);
        const request = bridgeCancelRequestSchema.parse({
          schemaVersion: 1,
          kind: "CANCEL_COMMAND",
          deviceId,
          commandId,
          goalId: target.goalId,
          configurationId: target.configurationId,
          serverInstanceId: configuration!.snapshot.serverInstanceId,
          requestId: cancelId,
          cancelId,
          timestamp: now.toISOString(),
          expiresAt: expiresAt.toISOString(),
          reason,
        });
        await tx.insert(cancels).values({
          cancelId,
          commandId,
          deviceId,
          key,
          request,
          interventionId,
          requestId: auditContext.getStore()?.requestId ?? randomUUID(),
          createdAt: now,
          expiresAt,
          nextAttemptAt: now,
        });
        await appendAudit(tx, {
          action: "command.cancel_requested",
          targetKind: "command",
          targetId: commandId,
          commandId,
          metadata: { interventionId, reason },
        });
        return { cancelId, replayed: false };
      });
    },
    async get(deviceId: string, commandId: string, now = new Date()) {
      await evaluate(now);
      const [row] = await db
        .select()
        .from(cancels)
        .where(
          and(eq(cancels.commandId, commandId), eq(cancels.deviceId, deviceId)),
        );
      if (!row) return null;
      const [command] = await db
        .select()
        .from(commands)
        .where(eq(commands.commandId, commandId));
      const [target] = await db
        .select()
        .from(targets)
        .where(eq(targets.commandId, commandId));
      return {
        ...row,
        intervention: {
          interventionId: row.interventionId,
          kind: "CANCEL_COMMAND",
          commandId: row.commandId,
          reason: row.request.reason,
          actorKind: row.actorKind,
          actorId: row.actorId,
          requestId: row.requestId,
          startedAt: row.createdAt,
          finishedAt: null,
          durationMs: null,
          cost: null,
        },
        terminalStatus: command!.executionStatus,
        stopConfirmation: target!.stopConfirmed
          ? "OBSERVED"
          : target!.notStarted
            ? "NOT_STARTED"
            : "UNKNOWN",
        humanReviewRequired:
          row.assessment === "UNCERTAIN" ||
          target!.conflicted ||
          (now >= row.expiresAt &&
            !target!.stopConfirmed &&
            !target!.notStarted),
        events: await db
          .select()
          .from(events)
          .where(eq(events.cancelId, row.cancelId))
          .orderBy(asc(events.receivedAt), asc(events.eventId)),
      };
    },
    async dispatch(
      publish: (
        topic: string,
        payload: string,
        expiresAt: Date,
      ) => Promise<void>,
      now = () => new Date(),
    ) {
      await evaluate(now());
      const candidates = await db
        .select()
        .from(cancels)
        .where(
          and(
            eq(cancels.phase, "REQUESTED"),
            eq(cancels.assessment, "PENDING"),
            lte(cancels.nextAttemptAt, now()),
          ),
        )
        .limit(100);
      for (const row of candidates) {
        const [claimed] = await db
          .update(cancels)
          .set({
            attempts: sql`${cancels.attempts}+1`,
            nextAttemptAt: new Date(now().getTime() + 3000),
          })
          .where(
            and(
              eq(cancels.cancelId, row.cancelId),
              eq(cancels.phase, "REQUESTED"),
              eq(cancels.assessment, "PENDING"),
              sql`${cancels.attempts}<3`,
              sql`${cancels.expiresAt}>${now().toISOString()}`,
              lte(cancels.nextAttemptAt, now()),
            ),
          )
          .returning();
        if (!claimed) continue;
        try {
          await publish(
            createBridgeRequestsTopic(row.deviceId),
            JSON.stringify(row.request),
            row.expiresAt,
          );
          await db.transaction(async (tx) => {
            await tx
              .update(cancels)
              .set({
                publishedAt: sql`coalesce(${cancels.publishedAt},${now().toISOString()}::timestamptz)`,
              })
              .where(eq(cancels.cancelId, row.cancelId));
            await appendAudit(tx, {
              action: "command.cancel_sent",
              targetKind: "command",
              targetId: row.commandId,
              commandId: row.commandId,
              system: "cancel-worker",
              metadata: {
                interventionId: row.interventionId,
                reason: "MQTT_PUBLISHED",
              },
            });
          });
        } catch {
          /* 送信例外に認証情報を残さず、試行数は送信前の記録を維持する。 */
        }
      }
    },
    async save(message: BridgeCancelEvent, receivedAt: Date) {
      const payloadHash = hash(message);
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bridge-event:${message.eventId}`},0))`,
        );
        const [old] = await tx
          .select()
          .from(events)
          .where(eq(events.eventId, message.eventId));
        if (old) {
          if (old.payloadHash !== payloadHash) {
            await tx
              .insert(bridgeConflicts)
              .values({ eventId: message.eventId, payloadHash, receivedAt });
            await tx
              .update(cancels)
              .set({ assessment: "UNCERTAIN" })
              .where(eq(cancels.cancelId, old.cancelId));
            return null;
          }
          return {
            schemaVersion: 1 as const,
            deviceId: message.deviceId,
            eventId: message.eventId,
            payloadHash,
            status: "STORED" as const,
            timestamp: old.receivedAt.toISOString(),
          };
        }
        for (const table of [bridgeReports, bridgeActionEvents]) {
          if (
            (
              await tx
                .select({ id: table.eventId })
                .from(table)
                .where(eq(table.eventId, message.eventId))
            ).length
          ) {
            await tx
              .insert(bridgeConflicts)
              .values({ eventId: message.eventId, payloadHash, receivedAt });
            return null;
          }
        }
        await tx
          .select()
          .from(devices)
          .where(eq(devices.deviceId, message.deviceId))
          .for("update");
        const [row] = await tx
          .select()
          .from(cancels)
          .where(eq(cancels.cancelId, message.cancelId))
          .for("update");
        const [target] = await tx
          .select()
          .from(targets)
          .where(eq(targets.commandId, message.commandId));
        const [report] = target
          ? await tx
              .select()
              .from(bridgeReports)
              .where(eq(bridgeReports.eventId, target.reportEventId))
          : [];
        let disposition = "APPLIED";
        if (
          !row ||
          row.requestId === null ||
          row.deviceId !== message.deviceId ||
          row.request.requestId !== message.requestId ||
          row.commandId !== message.commandId ||
          row.request.goalId !== message.goalId ||
          row.request.configurationId !== message.configurationId ||
          row.request.serverInstanceId !== message.serverInstanceId ||
          report?.message.journalId !== message.journalId
        )
          disposition = "UNMATCHED";
        else if (
          Date.parse(message.timestamp) < row.createdAt.getTime() ||
          Date.parse(message.timestamp) > receivedAt.getTime() + 5000
        )
          disposition = "CONFLICT";
        else {
          const response = message.response;
          if (message.rawResponse?.cdr) {
            const raw = Buffer.from(message.rawResponse.cdr, "base64");
            if (
              raw.toString("base64") !== message.rawResponse.cdr ||
              raw.length !== message.rawResponse.bytes ||
              createHash("sha256").update(raw).digest("hex") !==
                message.rawResponse.hash
            )
              disposition = "CONFLICT";
          }
          if (response) {
            const bytes = Buffer.from(response.cdr, "base64");
            if (
              bytes.toString("base64") !== response.cdr ||
              createHash("sha256").update(bytes).digest("hex") !==
                response.hash ||
              (message.phase === "ACCEPTED" &&
                (response.returnCode !== 0 ||
                  response.goalsCanceling.length !== 1 ||
                  response.goalsCanceling[0] !== message.goalId)) ||
              (message.phase === "REJECTED" &&
                ((response.returnCode === 0 &&
                  message.reason !== "NO_GOAL_CANCELING") ||
                  response.goalsCanceling.length !== 0))
            )
              disposition = "CONFLICT";
          } else if (["ACCEPTED", "REJECTED"].includes(message.phase))
            disposition = "CONFLICT";
          if (
            message.phase === "RECEIVED" &&
            (message.attempt !== 0 || message.reason !== "RECEIVED")
          )
            disposition = "CONFLICT";
          if (
            ["SEND_INTENT", "ACCEPTED", "REJECTED"].includes(message.phase) &&
            message.attempt === 0
          )
            disposition = "CONFLICT";
          if (
            response &&
            ((message.phase === "ACCEPTED" &&
              message.reason !== "CANCEL_ACCEPTED") ||
              (message.phase === "REJECTED" &&
                message.reason !==
                  [
                    "NO_GOAL_CANCELING",
                    "CANCEL_REJECTED",
                    "UNKNOWN_GOAL",
                    "ALREADY_TERMINAL",
                  ][response.returnCode]))
          )
            disposition = "CONFLICT";
          if (disposition === "APPLIED") {
            if (receivedAt >= row.expiresAt || row.assessment === "UNCERTAIN")
              disposition = "LATE";
            else if (["ACCEPTED", "REJECTED", "UNCERTAIN"].includes(row.phase))
              disposition =
                message.phase === row.phase ||
                ["RECEIVED", "SEND_INTENT"].includes(message.phase)
                  ? "STALE"
                  : row.phase === "ACCEPTED" &&
                      message.phase === "REJECTED" &&
                      message.reason === "ALREADY_TERMINAL"
                    ? "STALE"
                    : "CONFLICT";
            else if (
              row.phase === "SEND_INTENT" &&
              message.phase === "RECEIVED"
            )
              disposition = "STALE";
            else {
              await tx
                .update(cancels)
                .set({ phase: message.phase })
                .where(eq(cancels.cancelId, row.cancelId));
              await appendAudit(tx, {
                action: "command.cancel_changed",
                targetKind: "command",
                targetId: row.commandId,
                commandId: row.commandId,
                system: "telemetry-ingestor",
                metadata: {
                  interventionId: row.interventionId,
                  beforeStatus: row.phase,
                  afterStatus: message.phase,
                  reason: message.reason,
                },
              });
            }
          }
        }
        if (disposition === "CONFLICT" && row)
          await tx
            .update(cancels)
            .set({ assessment: "UNCERTAIN" })
            .where(eq(cancels.cancelId, row.cancelId));
        await tx.insert(events).values({
          eventId: message.eventId,
          cancelId: message.cancelId,
          deviceId: message.deviceId,
          payloadHash,
          message,
          disposition,
          receivedAt,
        });
        return {
          schemaVersion: 1 as const,
          deviceId: message.deviceId,
          eventId: message.eventId,
          payloadHash,
          status: "STORED" as const,
          timestamp: receivedAt.toISOString(),
        };
      });
    },
  };
}

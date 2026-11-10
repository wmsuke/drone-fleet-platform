import { createHash } from "node:crypto";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import {
  canonicalBridgeJson,
  type BridgeActionEvent,
} from "@drone-fleet/protocol";
import {
  bridgeActionEvents as events,
  bridgeConflicts as conflicts,
  bridgeReports,
  bridgeConfigurations,
  rosCommandTargets as targets,
  bridgeCommandConfigurations as bindings,
  commands,
  devices,
  bridgeCancelEvents,
  rosCommandCancels,
  bridgeHealthEvents,
} from "./schema.js";
import type { Database } from "./connection.js";
import type { Transaction } from "./ros-commands.js";
import { appendAudit } from "./audit.js";
const hash = (v: unknown) =>
  createHash("sha256").update(canonicalBridgeJson(v)).digest("hex");
const hashBytes = (cdr: string) => {
  const bytes = Buffer.from(cdr, "base64");
  return bytes.toString("base64") === cdr
    ? createHash("sha256").update(bytes).digest("hex")
    : null;
};
const terminal = ["SUCCEEDED", "FAILED", "REJECTED", "CANCELLED"];

// API受付時の不変report/configを使い、実ROS startedAtが得られたときだけ作る。
export async function bindExecution(
  tx: Transaction,
  target: typeof targets.$inferSelect,
  message: BridgeActionEvent,
  startedAt: Date,
) {
  await tx
    .insert(bindings)
    .values({
      commandId: target.commandId,
      goalId: message.goalId,
      configurationId: target.configurationId,
      reportEventId: target.reportEventId,
      startedAt,
    })
    .onConflictDoNothing();
  const [bound] = await tx
    .select()
    .from(bindings)
    .where(eq(bindings.commandId, target.commandId));
  return (
    bound?.goalId === message.goalId &&
    bound.configurationId === target.configurationId &&
    bound.reportEventId === target.reportEventId &&
    bound.startedAt.getTime() === startedAt.getTime()
  );
}
export function createBridgeExecutionRepository(db: Database) {
  return {
    async save(message: BridgeActionEvent, receivedAt: Date) {
      const payloadHash = hash(message);
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bridge-event:${message.eventId}`},0))`,
        );
        if (
          (
            await tx
              .select()
              .from(bridgeHealthEvents)
              .where(eq(bridgeHealthEvents.eventId, message.eventId))
          ).length
        ) {
          await tx
            .insert(conflicts)
            .values({ eventId: message.eventId, payloadHash, receivedAt });
          return null;
        }
        const [cancelEvent] = await tx
          .select()
          .from(bridgeCancelEvents)
          .where(eq(bridgeCancelEvents.eventId, message.eventId));
        if (cancelEvent) {
          await tx
            .insert(conflicts)
            .values({ eventId: message.eventId, payloadHash, receivedAt });
          await tx
            .update(rosCommandCancels)
            .set({ assessment: "UNCERTAIN" })
            .where(eq(rosCommandCancels.cancelId, cancelEvent.cancelId));
          return null;
        }
        const [old] = await tx
          .select()
          .from(events)
          .where(eq(events.eventId, message.eventId));
        const [configEvent] = await tx
          .select()
          .from(bridgeReports)
          .where(eq(bridgeReports.eventId, message.eventId));
        if (old || configEvent) {
          if (!old || old.payloadHash !== payloadHash) {
            await tx
              .insert(conflicts)
              .values({ eventId: message.eventId, payloadHash, receivedAt });
            if (old) {
              await tx
                .select()
                .from(devices)
                .where(eq(devices.deviceId, old.deviceId))
                .for("update");
              await tx
                .update(targets)
                .set({
                  conflicted: true,
                  stopConfirmed: false,
                  notStarted: false,
                })
                .where(eq(targets.commandId, old.commandId));
            }
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
        await tx
          .select()
          .from(devices)
          .where(eq(devices.deviceId, message.deviceId))
          .for("update");
        const [target] = await tx
          .select()
          .from(targets)
          .where(eq(targets.commandId, message.commandId))
          .for("update");
        const [command] = await tx
          .select()
          .from(commands)
          .where(eq(commands.commandId, message.commandId))
          .for("update");
        const [configuration] = target
          ? await tx
              .select()
              .from(bridgeConfigurations)
              .where(
                eq(
                  bridgeConfigurations.configurationId,
                  target.configurationId,
                ),
              )
          : [];
        const [report] = target
          ? await tx
              .select()
              .from(bridgeReports)
              .where(eq(bridgeReports.eventId, target.reportEventId))
          : [];
        let disposition = "APPLIED";
        const timestamp = new Date(message.timestamp);
        const validScope =
          target &&
          command &&
          configuration &&
          report &&
          target.deviceId === message.deviceId &&
          command.deviceId === message.deviceId &&
          configuration.deviceId === message.deviceId &&
          report.deviceId === message.deviceId &&
          target.configurationId === message.configurationId &&
          configuration.snapshot.serverInstanceId ===
            message.serverInstanceId &&
          report.message.journalId === message.journalId &&
          (!target.goalId || target.goalId === message.goalId);
        if (!validScope) disposition = "UNMATCHED";
        else if (
          timestamp.getTime() > receivedAt.getTime() + 5000 ||
          timestamp < command.createdAt
        )
          disposition = "CONFLICT";
        else if (target.conflicted) disposition = "CONFLICT";
        else {
          // 終端保存が先に失敗した場合、STOPは未確認のまま端末から再送させる。
          if (message.kind === "STOP_OBSERVATION" && !target.terminalEventId)
            return null;
          // 保存済み対応は以後差し替えない。未知goalの再送を作る処理は存在しない。
          if (!target.goalId)
            await tx
              .update(targets)
              .set({ goalId: message.goalId })
              .where(eq(targets.commandId, target.commandId));
          let next: string | null = null;
          let startedAt: Date | null = null;
          if (message.kind === "GOAL_ACCEPTED") {
            if (!target.acceptedAt)
              await tx
                .update(targets)
                .set({ acceptedAt: timestamp })
                .where(eq(targets.commandId, target.commandId));
          } else if (message.kind === "GOAL_REJECTED") {
            const evidence = message.adapterDecision;
            if (evidence && hashBytes(evidence.cdr) !== evidence.hash)
              disposition = "CONFLICT";
            next = "REJECTED";
          } else if (message.kind === "FEEDBACK") {
            // feedbackは開始証拠になるが、進捗から成功は作らない。
            next = "RUNNING";
            startedAt = new Date(message.startedAt);
          } else if (message.kind === "EXECUTION") {
            next = message.status;
            startedAt = message.startedAt ? new Date(message.startedAt) : null;
            const evidence = message.result;
            if (message.rawResult?.cdr) {
              const raw = Buffer.from(message.rawResult.cdr, "base64");
              if (
                raw.toString("base64") !== message.rawResult.cdr ||
                raw.length !== message.rawResult.bytes ||
                createHash("sha256").update(raw).digest("hex") !==
                  message.rawResult.hash
              )
                disposition = "CONFLICT";
            }
            if (terminal.includes(next) && next !== "REJECTED" && !evidence)
              disposition = "CONFLICT";
            if (evidence) {
              const bytes = Buffer.from(evidence.cdr, "base64");
              if (
                bytes.toString("base64") !== evidence.cdr ||
                createHash("sha256").update(bytes).digest("hex") !==
                  evidence.hash ||
                evidence.started !== !!startedAt ||
                evidence.startedAt !== (message.startedAt ?? null) ||
                evidence.finishedAt !== message.timestamp ||
                evidence.homeId !== configuration.snapshot.homeId ||
                evidence.poseFrame !==
                  configuration.snapshot.namespace.slice(1) + "/map" ||
                evidence.velocityFrame !== evidence.poseFrame ||
                (next === "SUCCEEDED" &&
                  (evidence.rosStatus !== 4 ||
                    evidence.homeDistanceMm > 200 ||
                    evidence.speedMmPerSecond > 50 ||
                    evidence.stableDurationMs < 1000 ||
                    message.reason !== "HOME_REACHED")) ||
                (next === "FAILED" && evidence.rosStatus !== 6) ||
                (next === "CANCELLED" && evidence.rosStatus !== 5) ||
                (next === "REJECTED" &&
                  (evidence.started || evidence.rosStatus !== 6))
              )
                disposition = "CONFLICT";
            }
          } else if (message.kind === "STOP_OBSERVATION") {
            const [result] = await tx
              .select()
              .from(events)
              .where(eq(events.eventId, message.terminalEventId));
            const end = Date.parse(message.lastSampleAt),
              begin = Date.parse(message.firstSampleAt);
            if (
              !target.terminalEventId ||
              target.terminalEventId !== message.terminalEventId ||
              !result ||
              result.disposition !== "APPLIED" ||
              !["SUCCEEDED", "FAILED", "CANCELLED"].includes(
                command.executionStatus,
              ) ||
              message.speedMmPerSecond > 50 ||
              message.dwellMs < 1000 ||
              end - begin < 1000 ||
              end <= begin ||
              begin < Date.parse(result.message.timestamp) ||
              message.dwellMs > end - begin ||
              end > timestamp.getTime() ||
              timestamp.getTime() - end >= 3000 ||
              timestamp.getTime() - Date.parse(result.message.timestamp) >
                5000 ||
              message.poseFrame !==
                configuration.snapshot.namespace.slice(1) + "/map"
            )
              disposition = "CONFLICT";
            else {
              await tx
                .update(targets)
                .set({ stopConfirmed: true })
                .where(eq(targets.commandId, target.commandId));
              await tx
                .update(bindings)
                .set({ stopConfirmed: true })
                .where(eq(bindings.commandId, target.commandId));
            }
          }
          if (next && disposition === "APPLIED") {
            if (
              next === "REJECTED" &&
              (startedAt ||
                command.executionStartedAt ||
                (message.kind === "EXECUTION" &&
                  !message.result &&
                  message.reason !== "REJECTED_EXPIRED"))
            )
              disposition = "CONFLICT";
            else if (
              startedAt &&
              (startedAt < command.createdAt ||
                !command.expiresAt ||
                startedAt >= command.expiresAt ||
                timestamp < startedAt ||
                (command.executionStartedAt &&
                  command.executionStartedAt.getTime() !== startedAt.getTime()))
            )
              disposition = "CONFLICT";
            else if (
              ["RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"].includes(next) &&
              !startedAt
            )
              disposition = "CONFLICT";
            else if (terminal.includes(command.executionStatus)) {
              disposition =
                next === command.executionStatus ||
                next === "RUNNING" ||
                next === "UNCERTAIN"
                  ? "STALE"
                  : "CONFLICT";
              if (
                next === command.executionStatus &&
                message.kind === "EXECUTION" &&
                message.result &&
                target.terminalEventId
              ) {
                const [canonical] = await tx
                  .select()
                  .from(events)
                  .where(eq(events.eventId, target.terminalEventId));
                if (
                  canonical?.message.kind === "EXECUTION" &&
                  canonical.message.result &&
                  canonical.message.result.hash !== message.result.hash
                )
                  disposition = "CONFLICT";
              }
            } else if (
              command.executionStatus === "UNCERTAIN" ||
              receivedAt >= target.resultDeadline ||
              timestamp >= target.resultDeadline
            )
              disposition = "LATE";
            else if (
              startedAt &&
              !(await bindExecution(tx, target, message, startedAt))
            )
              disposition = "CONFLICT";
            if (disposition === "APPLIED") {
              const finished = next !== "RUNNING";
              await tx
                .update(commands)
                .set({
                  executionStatus: next,
                  ...(startedAt
                    ? {
                        executionStartedAt: startedAt,
                        executionStartedReceivedAt:
                          command.executionStartedReceivedAt ?? receivedAt,
                      }
                    : {}),
                  ...(finished
                    ? {
                        executionResultAt: timestamp,
                        executionResultReceivedAt: receivedAt,
                      }
                    : {}),
                })
                .where(eq(commands.commandId, command.commandId));
              if (terminal.includes(next))
                await tx
                  .update(targets)
                  .set({
                    terminalEventId: message.eventId,
                    ...(message.kind === "GOAL_REJECTED" || next === "REJECTED"
                      ? { notStarted: true }
                      : {}),
                  })
                  .where(eq(targets.commandId, target.commandId));
              await appendAudit(tx, {
                action: "command.execution_changed",
                targetKind: "command",
                targetId: command.commandId,
                commandId: command.commandId,
                system: "telemetry-ingestor",
                metadata: {
                  beforeStatus: command.executionStatus,
                  afterStatus: next,
                },
              });
            }
          }
          if (disposition === "CONFLICT") {
            await tx
              .update(targets)
              .set({
                conflicted: true,
                stopConfirmed: false,
                notStarted: false,
              })
              .where(eq(targets.commandId, target.commandId));
            await appendAudit(tx, {
              action: "command.conflict",
              targetKind: "command",
              targetId: target.commandId,
              commandId: target.commandId,
              system: "telemetry-ingestor",
              result: "REJECTED",
              metadata: {
                reason: "RESULT_CONFLICT",
                beforeStatus: command.executionStatus,
                afterStatus:
                  message.kind === "EXECUTION" ? message.status : message.kind,
              },
            });
          }
        }
        await tx.insert(events).values({
          eventId: message.eventId,
          deviceId: message.deviceId,
          commandId: message.commandId,
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
    async expire(now: Date) {
      const open = await db
        .select()
        .from(targets)
        .where(
          and(
            eq(targets.stopConfirmed, false),
            eq(targets.notStarted, false),
            lte(targets.resultDeadline, now),
          ),
        )
        .orderBy(asc(targets.deviceId));
      for (const target of open)
        await db.transaction(async (tx) => {
          await tx
            .select()
            .from(devices)
            .where(eq(devices.deviceId, target.deviceId))
            .for("update");
          const [command] = await tx
            .select()
            .from(commands)
            .where(eq(commands.commandId, target.commandId))
            .for("update");
          if (
            !command ||
            terminal.includes(command.executionStatus) ||
            command.executionStatus === "UNCERTAIN"
          )
            return;
          await tx
            .update(commands)
            .set({
              executionStatus: "UNCERTAIN",
              executionResultAt: now,
              executionResultReceivedAt: now,
            })
            .where(eq(commands.commandId, target.commandId));
          await appendAudit(tx, {
            action: "command.execution_changed",
            targetKind: "command",
            targetId: target.commandId,
            commandId: target.commandId,
            system: "telemetry-ingestor",
            metadata: {
              beforeStatus: command.executionStatus,
              afterStatus: "UNCERTAIN",
            },
          });
        });
    },
    async get(commandId: string) {
      const [state] = await db
        .select({
          target: targets,
          command: commands,
          configuration: bridgeConfigurations.snapshot,
        })
        .from(targets)
        .innerJoin(commands, eq(commands.commandId, targets.commandId))
        .innerJoin(
          bridgeConfigurations,
          eq(bridgeConfigurations.configurationId, targets.configurationId),
        )
        .where(eq(targets.commandId, commandId));
      if (!state) return null;
      const evidence = await db
        .select()
        .from(events)
        .where(eq(events.commandId, commandId))
        .orderBy(asc(events.receivedAt), asc(events.eventId));
      const last = evidence
        .filter(
          (e) => e.disposition === "APPLIED" && e.message.kind === "EXECUTION",
        )
        .at(-1);
      const handoff =
        state.command.executionStatus === "UNCERTAIN" ||
        (["SUCCEEDED", "FAILED", "CANCELLED"].includes(
          state.command.executionStatus,
        ) &&
          !state.target.stopConfirmed) ||
        state.target.conflicted;
      return {
        ...state,
        recovery: {
          humanReviewRequired: handoff,
          automaticResubmit: false,
          evidenceEventId: last?.eventId ?? null,
          reason: last?.message.reason ?? null,
          nextAction: handoff ? "RECONCILE_EVIDENCE_AND_INSPECT_DEVICE" : null,
          completedAt: null,
          durationMs: null,
          cost: null,
        },
        events: evidence,
      };
    },
  };
}

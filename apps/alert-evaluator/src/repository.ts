import { randomUUID } from "node:crypto";
import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import {
  alerts,
  alertEvaluationStates,
  commands,
  devices,
  deviceOnlineObservations,
  telemetry,
  fleetOperations,
  fleetOperationTargets,
  type Database,
} from "@drone-fleet/database";
import { RULE_VERSION, type AlertPolicy } from "./config.js";
import {
  commandOutcome,
  evaluateDevice,
  type Decision,
  type DeviceState,
} from "./model.js";
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export interface EvaluationCounts {
  created: number;
  updated: number;
  resolved: number;
}
const empty = (): EvaluationCounts => ({ created: 0, updated: 0, resolved: 0 });
const same = (a: object, b: object) =>
  JSON.stringify(Object.entries(a).sort()) ===
  JSON.stringify(Object.entries(b).sort());
async function lock(tx: Tx, key: string) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${"alert:" + key}, 0))`,
  );
}
async function apply(
  tx: Tx,
  deviceId: string,
  commandId: string | null,
  decision: Decision,
  policy: AlertPolicy,
  counts: EvaluationCounts,
) {
  const key = commandId
    ? `command:${commandId}`
    : `device:${deviceId}:${decision.kind}`;
  const [current] = await tx
    .select()
    .from(alerts)
    .where(
      and(
        eq(alerts.deduplicationKey, key),
        commandId ? sql`true` : eq(alerts.status, "ACTIVE"),
      ),
    )
    .for("update");
  if (current?.status === "RESOLVED") return;
  if (!current) {
    if (decision.action !== "raise") return;
    await tx.insert(alerts).values({
      alertId: randomUUID(),
      deviceId,
      commandId,
      deduplicationKey: key,
      kind: decision.kind,
      reason: decision.reason,
      occurredAt: new Date(decision.at),
      lastObservedAt: new Date(decision.at),
      ruleVersion: RULE_VERSION,
      parameters: { ...policy },
      evidence: decision.evidence,
    });
    counts.created++;
    return;
  }
  if (
    commandId &&
    ["EXECUTION_FAILED", "EXPIRED"].includes(current.reason) &&
    current.reason !== decision.reason
  )
    return;
  if (
    decision.action === "resolve" &&
    commandId &&
    ["EXECUTION_FAILED", "EXPIRED"].includes(current.reason)
  )
    return;
  const at = new Date(Math.max(current.lastObservedAt.getTime(), decision.at));
  if (decision.action === "resolve") {
    await tx
      .update(alerts)
      .set({
        status: "RESOLVED",
        resolvedAt: at,
        lastObservedAt: at,
        reason: decision.reason,
        evidence: decision.evidence,
        parameters: { ...policy },
        ruleVersion: RULE_VERSION,
      })
      .where(eq(alerts.alertId, current.alertId));
    counts.resolved++;
    return;
  }
  if (
    current.reason === decision.reason &&
    current.lastObservedAt.getTime() === at.getTime() &&
    same(current.evidence, decision.evidence) &&
    same(current.parameters, policy)
  )
    return;
  await tx
    .update(alerts)
    .set({
      lastObservedAt: at,
      reason: decision.reason,
      evidence: decision.evidence,
      parameters: { ...policy },
      ruleVersion: RULE_VERSION,
    })
    .where(eq(alerts.alertId, current.alertId));
  counts.updated++;
}
export function createAlertRepository(db: Database, policy: AlertPolicy) {
  const fingerprint = JSON.stringify(policy);
  async function saveState(
    tx: Tx,
    key: string,
    now: Date,
    state: Record<string, unknown>,
  ) {
    await tx
      .insert(alertEvaluationStates)
      .values({
        targetKey: key,
        state,
        evaluatedAt: now,
        ruleVersion: RULE_VERSION,
      })
      .onConflictDoUpdate({
        target: alertEvaluationStates.targetKey,
        set: { state, evaluatedAt: now, ruleVersion: RULE_VERSION },
      });
  }
  return {
    async deviceIds() {
      return (
        await db
          .select({ id: devices.deviceId })
          .from(devices)
          .orderBy(asc(devices.deviceId))
      ).map((r) => r.id);
    },
    async commandIds(now: Date) {
      const result = await db.execute<{
        id: string;
      }>(sql`SELECT c.command_id AS id FROM commands c
        LEFT JOIN fleet_operation_targets t ON t.command_id=c.command_id
        LEFT JOIN fleet_operations o ON o.operation_id=t.operation_id
        WHERE (c.execution_status <> 'SUCCEEDED' AND (
          c.execution_status IN ('FAILED','UNCERTAIN') OR c.status IN ('FAILED','EXPIRED','TIMED_OUT')
          OR coalesce(o.result_deadline, c.created_at + ${policy.commandResultMs} * interval '1 millisecond') <= ${now.toISOString()}::timestamptz))
          OR EXISTS (SELECT 1 FROM alerts a WHERE a.command_id=c.command_id AND a.status='ACTIVE')
        ORDER BY c.command_id`);
      return result.map((r) => r.id);
    },
    async evaluateDevice(deviceId: string, now: Date) {
      return db.transaction(async (tx) => {
        const key = `device:${deviceId}`;
        await lock(tx, key);
        const [device] = await tx
          .select()
          .from(devices)
          .where(eq(devices.deviceId, deviceId))
          .for("share");
        const counts = empty();
        if (!device) return counts;
        const [checkpoint] = await tx
          .select()
          .from(alertEvaluationStates)
          .where(eq(alertEvaluationStates.targetKey, key));
        if (checkpoint && checkpoint.evaluatedAt > now) return counts;
        const cutoff = new Date(now.getTime() - policy.freshMs);
        const rows = await tx
          .select()
          .from(telemetry)
          .where(
            and(
              eq(telemetry.deviceId, deviceId),
              eq(telemetry.isRetained, false),
              eq(telemetry.identityOwner, true),
              gte(telemetry.receivedAt, cutoff),
              lte(telemetry.receivedAt, now),
            ),
          )
          .orderBy(asc(telemetry.receivedAt), asc(telemetry.id));
        const online = await tx
          .select()
          .from(deviceOnlineObservations)
          .where(
            and(
              eq(deviceOnlineObservations.deviceId, deviceId),
              gte(deviceOnlineObservations.receivedAt, cutoff),
              lte(deviceOnlineObservations.receivedAt, now),
            ),
          );
        const previous =
          checkpoint?.ruleVersion === RULE_VERSION &&
          checkpoint.state.fingerprint === fingerprint
            ? (checkpoint.state.device as DeviceState)
            : null;
        const result = evaluateDevice({
          online: device.connectionStatus === "ONLINE",
          changedAt: device.connectionChangedAt.getTime(),
          revision: device.connectionRevision,
          now: now.getTime(),
          previous,
          policy,
          facts: [
            ...rows.map((r) => ({
              key: `telemetry:${r.id}`,
              receivedAt: r.receivedAt.getTime(),
              deviceAt: r.deviceTimestamp.getTime(),
              battery: r.battery,
              session: r.sessionId ?? "legacy",
              sequence: r.sequence,
            })),
            ...online.map((r) => ({
              key: `online:${r.id}`,
              receivedAt: r.receivedAt.getTime(),
              deviceAt: r.deviceTimestamp.getTime(),
            })),
          ],
        });
        for (const decision of result.decisions)
          await apply(tx, deviceId, null, decision, policy, counts);
        await saveState(tx, key, now, { fingerprint, device: result.state });
        return counts;
      });
    },
    async evaluateCommand(commandId: string, now: Date) {
      return db.transaction(async (tx) => {
        const key = `command:${commandId}`;
        await lock(tx, key);
        const counts = empty();
        const [c] = await tx
          .select()
          .from(commands)
          .where(eq(commands.commandId, commandId))
          .for("share");
        if (!c) return counts;
        const [checkpoint] = await tx
          .select()
          .from(alertEvaluationStates)
          .where(eq(alertEvaluationStates.targetKey, key));
        if (checkpoint && checkpoint.evaluatedAt > now) return counts;
        const [operation] = await tx
          .select({ deadline: fleetOperations.resultDeadline })
          .from(fleetOperationTargets)
          .innerJoin(
            fleetOperations,
            eq(fleetOperations.operationId, fleetOperationTargets.operationId),
          )
          .where(eq(fleetOperationTargets.commandId, commandId));
        const deadline =
          operation?.deadline.getTime() ??
          c.createdAt.getTime() + policy.commandResultMs;
        const reason = commandOutcome(c, deadline, now.getTime());
        if (reason)
          await apply(
            tx,
            c.deviceId,
            commandId,
            {
              kind: "COMMAND_OUTCOME",
              action: reason === "SUCCEEDED" ? "resolve" : "raise",
              reason,
              at: now.getTime(),
              evidence: {
                commandStatus: c.status,
                executionStatus: c.executionStatus,
                resultDeadline: deadline,
              },
            },
            policy,
            counts,
          );
        await saveState(tx, key, now, { reason, deadline, fingerprint });
        return counts;
      });
    },
  };
}

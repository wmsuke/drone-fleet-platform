import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  canonicalBridgeJson,
  type BridgeHealthEvent,
} from "@drone-fleet/protocol";
import {
  bridgeHealthEvents as events,
  bridgeReports,
  bridgeActionEvents,
  bridgeCancelEvents,
  bridgeConflicts,
  bridgeConfigurationHeads as heads,
  devices,
} from "./schema.js";
import type { Database } from "./connection.js";
import { appendAudit } from "./audit.js";

export function createBridgeHealthRepository(db: Database) {
  return {
    async save(message: BridgeHealthEvent, receivedAt: Date) {
      const payloadHash = createHash("sha256")
        .update(canonicalBridgeJson(message))
        .digest("hex");
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bridge-event:${message.eventId}`},0))`,
        );
        const [old] = await tx
          .select()
          .from(events)
          .where(eq(events.eventId, message.eventId));
        const collision =
          (
            await tx
              .select()
              .from(bridgeReports)
              .where(eq(bridgeReports.eventId, message.eventId))
          ).length ||
          (
            await tx
              .select()
              .from(bridgeActionEvents)
              .where(eq(bridgeActionEvents.eventId, message.eventId))
          ).length ||
          (
            await tx
              .select()
              .from(bridgeCancelEvents)
              .where(eq(bridgeCancelEvents.eventId, message.eventId))
          ).length;
        if (collision || (old && old.payloadHash !== payloadHash)) {
          await tx
            .insert(bridgeConflicts)
            .values({ eventId: message.eventId, payloadHash, receivedAt });
          return null;
        }
        const receipt = (time: Date) => ({
          schemaVersion: 1 as const,
          deviceId: message.deviceId,
          eventId: message.eventId,
          payloadHash,
          status: "STORED" as const,
          timestamp: time.toISOString(),
        });
        if (old) return receipt(old.receivedAt);
        await tx
          .insert(devices)
          .values({ deviceId: message.deviceId })
          .onConflictDoNothing();
        await tx
          .select()
          .from(devices)
          .where(eq(devices.deviceId, message.deviceId))
          .for("update");
        const [head] = await tx
          .select()
          .from(heads)
          .where(eq(heads.deviceId, message.deviceId));
        // 構成報告より先着したhealthを未対応として確定しない。元eventの再送を待つ。
        if (!head?.configurationId) return null;
        const [previous] = await tx
          .select()
          .from(events)
          .where(
            and(
              eq(events.deviceId, message.deviceId),
              eq(events.disposition, "CURRENT"),
              sql`${events.message}->>'journalId'=${head.journalId}`,
            ),
          )
          .orderBy(desc(sql`(${events.message}->>'sequence')::bigint`))
          .limit(1);
        const disposition =
          head.journalId !== message.journalId ||
          head.configurationId !== message.configurationId
            ? "UNMATCHED"
            : Math.abs(receivedAt.getTime() - Date.parse(message.timestamp)) >=
                15000
              ? "CLOCK_INVALID"
              : previous && previous.message.sequence >= message.sequence
                ? "STALE"
                : "CURRENT";
        await tx.insert(events).values({
          eventId: message.eventId,
          deviceId: message.deviceId,
          payloadHash,
          message,
          receivedAt,
          disposition,
        });
        if (
          disposition === "CURRENT" &&
          (!previous ||
            previous.message.reason !== message.reason ||
            previous.message.pendingGoal?.humanReviewRequired !==
              message.pendingGoal?.humanReviewRequired)
        )
          await appendAudit(tx, {
            action: "bridge.health_changed",
            targetKind: "device",
            targetId: message.deviceId,
            system: "telemetry-ingestor",
            commandId: message.pendingGoal?.commandId,
            metadata: {
              reason: message.reason,
              ...(previous ? { beforeReason: previous.message.reason } : {}),
            },
          });
        return receipt(receivedAt);
      });
    },
    async get(deviceId: string, now = new Date()) {
      const [head] = await db
        .select()
        .from(heads)
        .where(eq(heads.deviceId, deviceId));
      const [latest] = await db
        .select()
        .from(events)
        .where(
          and(
            eq(events.deviceId, deviceId),
            eq(events.disposition, "CURRENT"),
            sql`${events.message}->>'journalId'=${head?.journalId ?? ""}`,
          ),
        )
        .orderBy(desc(sql`(${events.message}->>'sequence')::bigint`))
        .limit(1);
      const conflict = latest
        ? (
            await db
              .select()
              .from(bridgeConflicts)
              .where(eq(bridgeConflicts.eventId, latest.eventId))
              .limit(1)
          ).length > 0
        : false;
      const fresh =
        !!latest &&
        !conflict &&
        latest.message.configurationId === head?.configurationId &&
        [
          latest.receivedAt.getTime(),
          Date.parse(latest.message.timestamp),
        ].every((t) => now.getTime() >= t && now.getTime() - t < 15000);
      return {
        latest: latest ?? null,
        fresh,
        ready: fresh && !!latest?.message.ready,
        humanReviewRequired: !!latest?.message.pendingGoal?.humanReviewRequired,
        physicalStopConfirmed: false as const,
      };
    },
    async history(deviceId: string, limit: number) {
      return db
        .select()
        .from(events)
        .where(eq(events.deviceId, deviceId))
        .orderBy(desc(events.receivedAt), desc(events.eventId))
        .limit(limit);
    },
  };
}

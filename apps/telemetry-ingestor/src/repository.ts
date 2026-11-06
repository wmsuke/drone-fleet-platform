import {
  devices,
  telemetry,
  rosObservations,
  observationIdentities,
  observationConflicts,
  type Database,
  type NewTelemetry,
  type Telemetry,
} from "@drone-fleet/database";
import type {
  TelemetryMessage,
  LegacyTelemetryMessage,
} from "@drone-fleet/protocol";
import { isDeepStrictEqual } from "node:util";
import { and, eq, or, sql, inArray, asc } from "drizzle-orm";

export interface TelemetryBatchEntry {
  message: TelemetryMessage;
  receivedAt: Date;
  isRetained: boolean;
}

export interface TelemetryRepository {
  saveBatch(
    entries: readonly TelemetryBatchEntry[],
  ): Promise<readonly TelemetrySaveOutcome[]>;
}

export type TelemetrySaveOutcome = "saved" | "duplicate" | "conflict";

function identity(message: TelemetryMessage): string {
  return `${message.deviceId}/${message.schemaVersion !== 1 ? message.sessionId : "v1"}/${message.sequence}`;
}

function matches(row: Telemetry, message: LegacyTelemetryMessage): boolean {
  const payload = message.payload;
  return (
    (row.sourcePayload === null ||
      row.sourcePayload.timestamp === message.timestamp) &&
    row.deviceTimestamp.getTime() === new Date(message.timestamp).getTime() &&
    (row.sourcePayload === null
      ? Math.fround(row.battery) === Math.fround(payload.battery)
      : row.sourcePayload.battery === payload.battery) &&
    row.latitude === payload.latitude &&
    row.longitude === payload.longitude &&
    row.altitude === payload.altitude &&
    row.temperature === payload.temperature &&
    row.flightStatus === payload.status
  );
}

export function toNewTelemetry(
  message: LegacyTelemetryMessage,
  receivedAt: Date,
  isRetained = false,
): NewTelemetry {
  return {
    deviceId: message.deviceId,
    sessionId: message.schemaVersion === 2 ? message.sessionId : null,
    sequence: message.sequence,
    deviceTimestamp: new Date(message.timestamp),
    receivedAt,
    isRetained,
    battery: message.payload.battery,
    latitude: message.payload.latitude,
    longitude: message.payload.longitude,
    altitude: message.payload.altitude,
    temperature: message.payload.temperature,
    flightStatus: message.payload.status,
    ...(message.schemaVersion === 2
      ? { sourcePayload: { ...message.payload, timestamp: message.timestamp } }
      : {}),
  };
}

export function createTelemetryRepository(
  database: Database,
): TelemetryRepository {
  return {
    async saveBatch(batch) {
      if (batch.length === 0) return [];
      return database.transaction(async (transaction) => {
        // v2/v3で同じidentityを取り合う。deviceの行ロックも順序を固定する。
        const deviceIds = [
          ...new Set(batch.map((e) => e.message.deviceId)),
        ].sort();
        await transaction
          .insert(devices)
          .values(
            deviceIds.map((deviceId) => ({
              deviceId,
              updatedAt: batch.find(
                (e) => e.message.deviceId === deviceId && !e.isRetained,
              )?.receivedAt,
            })),
          )
          .onConflictDoNothing();
        await transaction
          .select({ deviceId: devices.deviceId })
          .from(devices)
          .where(inArray(devices.deviceId, deviceIds))
          .orderBy(asc(devices.deviceId))
          .for("update");
        const versioned = batch.filter((e) => e.message.schemaVersion !== 1);
        const first = new Map(versioned.map((e) => [identity(e.message), e]));
        // Mapの最後の要素ではなく最初に到着した本文を正本にする。
        for (const e of [...versioned].reverse())
          first.set(identity(e.message), e);
        const claimed = first.size
          ? await transaction
              .insert(observationIdentities)
              .values(
                [...first.values()]
                  .sort((a, b) =>
                    identity(a.message).localeCompare(identity(b.message)),
                  )
                  .map(({ message }) => ({
                    deviceId: message.deviceId,
                    sessionId:
                      message.schemaVersion === 1 ? "" : message.sessionId,
                    sequence: message.sequence,
                    message,
                  })),
              )
              .onConflictDoNothing()
              .returning()
          : [];
        const saved = new Set(
          claimed.map((r) => `${r.deviceId}/${r.sessionId}/${r.sequence}`),
        );
        const canonical = first.size
          ? await transaction
              .select()
              .from(observationIdentities)
              .where(
                or(
                  ...[...first.values()].map(({ message }) =>
                    and(
                      eq(observationIdentities.deviceId, message.deviceId),
                      eq(
                        observationIdentities.sessionId,
                        message.schemaVersion === 1 ? "" : message.sessionId,
                      ),
                      eq(observationIdentities.sequence, message.sequence),
                    ),
                  ),
                ),
              )
          : [];
        const bodies = new Map(
          canonical.map((r) => [
            `${r.deviceId}/${r.sessionId}/${r.sequence}`,
            r.message,
          ]),
        );
        const results: TelemetrySaveOutcome[] = [];
        const rosRows: (typeof rosObservations.$inferInsert)[] = [];
        const conflicts: (typeof observationConflicts.$inferInsert)[] = [];
        for (const entry of batch) {
          const { message } = entry;
          if (message.schemaVersion === 1) {
            results.push("saved");
            continue;
          }
          const key = identity(message);
          if (!isDeepStrictEqual(bodies.get(key), message)) {
            conflicts.push({
              deviceId: message.deviceId,
              sessionId: message.sessionId,
              sequence: message.sequence,
              message,
              receivedAt: entry.receivedAt,
            });
            results.push("conflict");
          } else {
            const fresh = saved.delete(key);
            results.push(fresh ? "saved" : "duplicate");
            if (fresh && message.schemaVersion === 3)
              rosRows.push({
                deviceId: message.deviceId,
                sessionId: message.sessionId,
                sequence: message.sequence,
                deviceTimestamp: new Date(message.timestamp),
                receivedAt: entry.receivedAt,
                isRetained: entry.isRetained,
                payload: message.payload,
              });
          }
        }
        if (rosRows.length)
          await transaction.insert(rosObservations).values(rosRows);
        if (conflicts.length)
          await transaction.insert(observationConflicts).values(conflicts);
        const entries = batch.filter(
          (e, i) => e.message.schemaVersion !== 3 && results[i] !== "conflict",
        ) as (TelemetryBatchEntry & { message: LegacyTelemetryMessage })[];
        const candidates = new Map<
          string,
          TelemetryBatchEntry & { message: LegacyTelemetryMessage }
        >();
        const legacy: (TelemetryBatchEntry & {
          message: LegacyTelemetryMessage;
        })[] = [];
        for (const entry of entries) {
          if (entry.message.schemaVersion === 1) legacy.push(entry);
          else if (!candidates.has(identity(entry.message)))
            candidates.set(identity(entry.message), entry);
        }
        const ordered = [...candidates.entries()].sort(([a], [b]) =>
          a.localeCompare(b),
        );
        const inserted = entries.length
          ? await transaction
              .insert(telemetry)
              .values(
                [...ordered.map(([, entry]) => entry), ...legacy].map(
                  ({ message, receivedAt, isRetained }) =>
                    toNewTelemetry(message, receivedAt, isRetained),
                ),
              )
              .onConflictDoNothing({
                target: [
                  telemetry.deviceId,
                  telemetry.sessionId,
                  telemetry.sequence,
                ],
                where: sql`${telemetry.sessionId} is not null and ${telemetry.identityOwner}`,
              })
              .returning({
                deviceId: telemetry.deviceId,
                sessionId: telemetry.sessionId,
                sequence: telemetry.sequence,
              })
          : [];
        const newlySaved = new Set(
          inserted
            .filter(({ sessionId }) => sessionId !== null)
            .map(
              ({ deviceId, sessionId, sequence }) =>
                `${deviceId}/${sessionId}/${sequence}`,
            ),
        );
        const existing =
          ordered.length === 0
            ? []
            : await transaction
                .select()
                .from(telemetry)
                .where(
                  and(
                    eq(telemetry.identityOwner, true),
                    or(
                      ...ordered.map(([, { message }]) =>
                        and(
                          eq(telemetry.deviceId, message.deviceId),
                          eq(
                            telemetry.sessionId,
                            message.schemaVersion === 2
                              ? message.sessionId
                              : "",
                          ),
                          eq(telemetry.sequence, message.sequence),
                        ),
                      ),
                    ),
                  ),
                );
        const rows = new Map(
          existing.map((row) => [
            `${row.deviceId}/${row.sessionId}/${row.sequence}`,
            row,
          ]),
        );
        const outcomes = entries.map(({ message }): TelemetrySaveOutcome => {
          if (message.schemaVersion === 1) return "saved";
          const key = identity(message);
          const row = rows.get(key);
          if (row === undefined)
            throw new Error("telemetry identity was not found after insert");
          if (!matches(row, message)) return "conflict";
          return newlySaved.delete(key) ? "saved" : "duplicate";
        });
        const deviceReceipts = new Map<string, Date>();
        for (const [index, entry] of batch.entries()) {
          if (entry.isRetained || results[index] === "conflict") continue;
          const current = deviceReceipts.get(entry.message.deviceId);
          if (current === undefined || entry.receivedAt > current) {
            deviceReceipts.set(entry.message.deviceId, entry.receivedAt);
          }
        }

        if (deviceReceipts.size > 0) {
          await transaction
            .insert(devices)
            .values(
              [...deviceReceipts]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([deviceId, receivedAt]) => ({
                  deviceId,
                  connectionStatus: "ONLINE" as const,
                  lastReceivedAt: receivedAt,
                  updatedAt: receivedAt,
                  connectionChangedAt: receivedAt,
                })),
            )
            .onConflictDoUpdate({
              target: devices.deviceId,
              set: {
                lastReceivedAt: sql`greatest(coalesce(${devices.lastReceivedAt}, excluded.last_received_at), excluded.last_received_at)`,
                updatedAt: sql`greatest(${devices.updatedAt}, excluded.updated_at)`,
                connectionStatus: sql`case when ${devices.lastReceivedAt} is null or ${devices.lastReceivedAt} <= excluded.last_received_at then 'ONLINE'::connection_status else ${devices.connectionStatus} end`,
                connectionChangedAt: sql`case when (${devices.lastReceivedAt} is null or ${devices.lastReceivedAt} <= excluded.last_received_at) AND ${devices.connectionStatus} <> 'ONLINE' then greatest(${devices.connectionChangedAt}, excluded.last_received_at) else ${devices.connectionChangedAt} end`,
                connectionRevision: sql`case when (${devices.lastReceivedAt} is null or ${devices.lastReceivedAt} <= excluded.last_received_at) AND ${devices.connectionStatus} <> 'ONLINE' then ${devices.connectionRevision} + 1 else ${devices.connectionRevision} end`,
              },
            });
        }

        // 旧行との照合も維持する（migration以前のfloat丸めを含む）。
        if (outcomes.some((o) => o === "conflict"))
          throw new Error("legacy identity mismatch");
        return results;
      });
    },
  };
}

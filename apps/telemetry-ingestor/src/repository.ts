import {
  devices,
  telemetry,
  type Database,
  type NewTelemetry,
  type Telemetry,
} from "@drone-fleet/database";
import type { TelemetryMessage } from "@drone-fleet/protocol";
import { and, eq, or, sql } from "drizzle-orm";

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
  return `${message.deviceId}/${message.schemaVersion === 2 ? message.sessionId : "v1"}/${message.sequence}`;
}

function matches(row: Telemetry, message: TelemetryMessage): boolean {
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
  message: TelemetryMessage,
  receivedAt: Date,
): NewTelemetry {
  return {
    deviceId: message.deviceId,
    sessionId: message.schemaVersion === 2 ? message.sessionId : null,
    sequence: message.sequence,
    deviceTimestamp: new Date(message.timestamp),
    receivedAt,
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
    async saveBatch(entries) {
      if (entries.length === 0) return [];
      return database.transaction(async (transaction) => {
        // 同時バッチでもdeviceと一意キーのロック取得順を揃える。
        await transaction
          .insert(devices)
          .values(
            [...new Set(entries.map(({ message }) => message.deviceId))]
              .sort()
              .map((deviceId) => ({
                deviceId,
                updatedAt: entries.find(
                  (entry) =>
                    entry.message.deviceId === deviceId && !entry.isRetained,
                )?.receivedAt,
              })),
          )
          .onConflictDoNothing({ target: devices.deviceId });
        const candidates = new Map<string, TelemetryBatchEntry>();
        const legacy: TelemetryBatchEntry[] = [];
        for (const entry of entries) {
          if (entry.message.schemaVersion === 1) legacy.push(entry);
          else if (!candidates.has(identity(entry.message)))
            candidates.set(identity(entry.message), entry);
        }
        const ordered = [...candidates.entries()].sort(([a], [b]) =>
          a.localeCompare(b),
        );
        const inserted = await transaction
          .insert(telemetry)
          .values(
            [...ordered.map(([, entry]) => entry), ...legacy].map(
              ({ message, receivedAt }) => toNewTelemetry(message, receivedAt),
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
          });
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
        for (const [index, entry] of entries.entries()) {
          if (entry.isRetained || outcomes[index] === "conflict") continue;
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
                })),
            )
            .onConflictDoUpdate({
              target: devices.deviceId,
              set: {
                lastReceivedAt: sql`greatest(coalesce(${devices.lastReceivedAt}, excluded.last_received_at), excluded.last_received_at)`,
                updatedAt: sql`greatest(${devices.updatedAt}, excluded.updated_at)`,
                connectionStatus: sql`case when ${devices.lastReceivedAt} is null or ${devices.lastReceivedAt} <= excluded.last_received_at then 'ONLINE'::connection_status else ${devices.connectionStatus} end`,
              },
            });
        }

        return outcomes;
      });
    },
  };
}

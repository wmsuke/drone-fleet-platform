import {
  telemetryV2MessageSchema,
  type TelemetryV2Message,
} from "@drone-fleet/protocol";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface TelemetryBufferLimits {
  maxRows: number;
  maxBytes: number;
}

export interface BufferedTelemetry {
  id: number;
  sessionId: string;
  sequence: number;
  payloadJson: string;
  createdAt: string;
  attemptCount: number;
  lastAttemptAt: string | null;
  publishedAt: string | null;
}

export interface TelemetryDiscard {
  count: number;
  firstSessionId: string;
  firstSequence: number;
  lastSessionId: string;
  lastSequence: number;
  occurredAt: string;
  reason: "ROW_LIMIT" | "BYTE_LIMIT" | "OVERSIZED";
}

export interface TelemetryBufferStats {
  rows: number;
  bytes: number;
  discarded: number;
}

export interface PendingTelemetryStats {
  count: number;
  oldestCreatedAt: string | null;
}

export interface TelemetryAppendResult {
  stored: boolean;
  discard?: TelemetryDiscard;
}

const SCHEMA_VERSION = 2;

export class TelemetryBuffer {
  private readonly database: DatabaseSync;

  constructor(
    path: string,
    private readonly deviceId: string,
    private readonly limits: TelemetryBufferLimits,
  ) {
    if (
      !Number.isSafeInteger(limits.maxRows) ||
      limits.maxRows < 1 ||
      !Number.isSafeInteger(limits.maxBytes) ||
      limits.maxBytes < 1
    ) {
      throw new TypeError(
        "telemetry buffer limits must be positive safe integers",
      );
    }
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    try {
      this.database.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
      );
      this.migrate();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  private migrate(): void {
    const version = (
      this.database.prepare("PRAGMA user_version").get() as {
        user_version: number;
      }
    ).user_version;
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `unsupported telemetry buffer schema version: ${version}`,
      );
    }
    if (version === 0) {
      this.transaction(() => {
        this.database.exec(`
          CREATE TABLE telemetry_buffer (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            payload_json TEXT NOT NULL,
            payload_bytes INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            last_attempt_at TEXT,
            published_at TEXT,
            UNIQUE (device_id, session_id, sequence)
          );
          CREATE TABLE telemetry_discards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            count INTEGER NOT NULL,
            first_session_id TEXT NOT NULL,
            first_sequence INTEGER NOT NULL,
            last_session_id TEXT NOT NULL,
            last_sequence INTEGER NOT NULL,
            occurred_at TEXT NOT NULL,
            reason TEXT NOT NULL
          );
          PRAGMA user_version=1;
        `);
      });
    }
    if (version < 2) {
      this.transaction(() => {
        this.database.exec(`
          CREATE INDEX telemetry_buffer_pending_idx
            ON telemetry_buffer (published_at, id);
          PRAGMA user_version=2;
        `);
      });
    }
  }

  private transaction<T>(work: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  append(message: TelemetryV2Message): TelemetryAppendResult {
    const validated = telemetryV2MessageSchema.parse(message);
    if (validated.deviceId !== this.deviceId) {
      throw new TypeError("telemetry deviceId does not match buffer deviceId");
    }
    const payloadJson = JSON.stringify(validated);
    const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
    const identity = {
      sessionId: validated.sessionId,
      sequence: validated.sequence,
    };
    return this.transaction(() => {
      if (payloadBytes > this.limits.maxBytes) {
        const discard = this.recordDiscard([identity], "OVERSIZED");
        return { stored: false, discard };
      }

      const usage = this.database
        .prepare(
          "SELECT count(*) AS rows, coalesce(sum(payload_bytes), 0) AS bytes FROM telemetry_buffer",
        )
        .get() as { rows: number; bytes: number };
      const removed: (typeof identity)[] = [];
      let reason: TelemetryDiscard["reason"] | undefined;
      while (
        usage.rows + 1 > this.limits.maxRows ||
        usage.bytes + payloadBytes > this.limits.maxBytes
      ) {
        reason ??=
          usage.rows + 1 > this.limits.maxRows ? "ROW_LIMIT" : "BYTE_LIMIT";
        const oldest = this.database
          .prepare(
            "SELECT id, session_id AS sessionId, sequence, payload_bytes AS payloadBytes FROM telemetry_buffer ORDER BY id LIMIT 1",
          )
          .get() as
          | {
              id: number;
              sessionId: string;
              sequence: number;
              payloadBytes: number;
            }
          | undefined;
        if (oldest === undefined)
          throw new Error("telemetry buffer capacity calculation failed");
        this.database
          .prepare("DELETE FROM telemetry_buffer WHERE id = ?")
          .run(oldest.id);
        removed.push({
          sessionId: oldest.sessionId,
          sequence: oldest.sequence,
        });
        usage.rows -= 1;
        usage.bytes -= oldest.payloadBytes;
      }
      this.database
        .prepare(
          `
        INSERT INTO telemetry_buffer
          (device_id, session_id, sequence, payload_json, payload_bytes, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          this.deviceId,
          validated.sessionId,
          validated.sequence,
          payloadJson,
          payloadBytes,
          validated.timestamp,
        );
      const discard =
        removed.length > 0 ? this.recordDiscard(removed, reason!) : undefined;
      return discard === undefined
        ? { stored: true }
        : { stored: true, discard };
    });
  }

  private recordDiscard(
    identities: Array<{ sessionId: string; sequence: number }>,
    reason: TelemetryDiscard["reason"],
  ): TelemetryDiscard {
    const first = identities[0]!;
    const last = identities[identities.length - 1]!;
    const discard: TelemetryDiscard = {
      count: identities.length,
      firstSessionId: first.sessionId,
      firstSequence: first.sequence,
      lastSessionId: last.sessionId,
      lastSequence: last.sequence,
      occurredAt: new Date().toISOString(),
      reason,
    };
    this.database
      .prepare(
        `
      INSERT INTO telemetry_discards
        (count, first_session_id, first_sequence, last_session_id,
         last_sequence, occurred_at, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        discard.count,
        discard.firstSessionId,
        discard.firstSequence,
        discard.lastSessionId,
        discard.lastSequence,
        discard.occurredAt,
        discard.reason,
      );
    return discard;
  }

  markAttempted(sessionId: string, sequence: number, at: string): void {
    this.database
      .prepare(
        `
      UPDATE telemetry_buffer SET attempt_count = attempt_count + 1,
        last_attempt_at = ? WHERE device_id = ? AND session_id = ? AND sequence = ?
    `,
      )
      .run(at, this.deviceId, sessionId, sequence);
  }

  markPublished(sessionId: string, sequence: number, at: string): void {
    this.database
      .prepare(
        `
      UPDATE telemetry_buffer SET published_at = ?
      WHERE device_id = ? AND session_id = ? AND sequence = ?
    `,
      )
      .run(at, this.deviceId, sessionId, sequence);
  }

  listUnconfirmed(): BufferedTelemetry[] {
    return this.database
      .prepare(
        `
      SELECT id, session_id AS sessionId, sequence,
        payload_json AS payloadJson, created_at AS createdAt,
        attempt_count AS attemptCount, last_attempt_at AS lastAttemptAt,
        published_at AS publishedAt
      FROM telemetry_buffer WHERE device_id = ? ORDER BY id
    `,
      )
      .all(this.deviceId) as unknown as BufferedTelemetry[];
  }

  peekPendingPublish(): BufferedTelemetry | undefined {
    return this.database
      .prepare(
        `SELECT id, session_id AS sessionId, sequence,
          payload_json AS payloadJson, created_at AS createdAt,
          attempt_count AS attemptCount, last_attempt_at AS lastAttemptAt,
          published_at AS publishedAt
         FROM telemetry_buffer
         WHERE device_id = ?
         ORDER BY id LIMIT 1`,
      )
      .get(this.deviceId) as BufferedTelemetry | undefined;
  }

  pendingPublishStats(): PendingTelemetryStats {
    return this.database
      .prepare(
        `SELECT count(*) AS count,
           (SELECT created_at FROM telemetry_buffer
             WHERE device_id = ?
             ORDER BY id LIMIT 1) AS oldestCreatedAt
         FROM telemetry_buffer
         WHERE device_id = ?`,
      )
      .get(this.deviceId, this.deviceId) as unknown as PendingTelemetryStats;
  }

  listDiscards(): TelemetryDiscard[] {
    return this.database
      .prepare(
        `
      SELECT count, first_session_id AS firstSessionId,
        first_sequence AS firstSequence, last_session_id AS lastSessionId,
        last_sequence AS lastSequence, occurred_at AS occurredAt, reason
      FROM telemetry_discards ORDER BY id
    `,
      )
      .all() as unknown as TelemetryDiscard[];
  }

  brokerAcknowledgedCount(): number {
    return (
      this.database
        .prepare(
          "SELECT count(*) AS count FROM telemetry_buffer WHERE device_id = ? AND published_at IS NOT NULL",
        )
        .get(this.deviceId) as { count: number }
    ).count;
  }

  stats(): TelemetryBufferStats {
    const usage = this.database
      .prepare(
        "SELECT count(*) AS rows, coalesce(sum(payload_bytes), 0) AS bytes FROM telemetry_buffer",
      )
      .get() as { rows: number; bytes: number };
    const discarded = this.database
      .prepare(
        "SELECT coalesce(sum(count), 0) AS count FROM telemetry_discards",
      )
      .get() as { count: number };
    return { ...usage, discarded: discarded.count };
  }

  confirmStored(sessionId: string, sequence: number): boolean {
    return (
      this.database
        .prepare(
          "DELETE FROM telemetry_buffer WHERE device_id = ? AND session_id = ? AND sequence = ?",
        )
        .run(this.deviceId, sessionId, sequence).changes > 0
    );
  }

  close(): void {
    this.database.close();
  }
}

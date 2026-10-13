import {
  commandAcknowledgementMessageSchema,
  commandMessageSchema,
  type CommandMessage,
  type CommandAcknowledgementMessage,
} from "@drone-fleet/protocol";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface CommandStoreOptions {
  path?: string;
  maxRows?: number;
  retentionMs?: number;
  clockTrusted?: boolean;
}
export interface StoredCommand {
  acknowledgement: CommandAcknowledgementMessage;
  action: CommandMessage["type"] | null;
}
interface Row {
  command_json: string;
  ack_json: string;
  state: "RECEIVED" | "STARTED" | "COMPLETED" | "EXPIRED" | "UNCERTAIN";
}

export class CommandStore {
  private readonly db: DatabaseSync;
  private readonly maxRows: number;
  private readonly retentionMs: number;
  private lastTime = -Infinity;
  constructor(
    private readonly deviceId: string,
    private readonly options: CommandStoreOptions = {},
  ) {
    this.maxRows = options.maxRows ?? 10_000;
    this.retentionMs = options.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
    if (
      !Number.isSafeInteger(this.maxRows) ||
      this.maxRows < 1 ||
      !Number.isSafeInteger(this.retentionMs) ||
      this.retentionMs < 1
    )
      throw new TypeError(
        "command history limits must be positive safe integers",
      );
    const path = options.path ?? ":memory:";
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      this.db
        .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS command_history (
          device_id TEXT NOT NULL, command_id TEXT NOT NULL, command_json TEXT NOT NULL,
          expires_at INTEGER NOT NULL, received_at TEXT NOT NULL, accepted_at TEXT,
          state TEXT NOT NULL, started_at TEXT, processed_at TEXT,
          ack_json TEXT NOT NULL, ack_pending INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY (device_id, command_id)
        );`);
      const uncertain = this.db
        .prepare(
          "UPDATE command_history SET state='UNCERTAIN' WHERE device_id=? AND state='STARTED'",
        )
        .run(deviceId).changes;
      if (uncertain > 0)
        console.warn(
          "停止前に開始したコマンドの結果が不明です。自動再実行しません",
          { deviceId, count: uncertain, state: "UNCERTAIN" },
        );
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private time(timestamp: string): number {
    const now = Date.parse(timestamp);
    if (
      this.options.clockTrusted === false ||
      !Number.isFinite(now) ||
      now < this.lastTime
    )
      throw new Error("command clock is not trusted or moved backwards");
    this.lastTime = now;
    return now;
  }
  private find(id: string): Row | undefined {
    return this.db
      .prepare(
        "SELECT command_json, ack_json, state FROM command_history WHERE device_id=? AND command_id=?",
      )
      .get(this.deviceId, id.toLowerCase()) as unknown as Row | undefined;
  }
  private result(row: Row): StoredCommand {
    const command = commandMessageSchema.parse(JSON.parse(row.command_json));
    return {
      acknowledgement: commandAcknowledgementMessageSchema.parse(
        JSON.parse(row.ack_json),
      ),
      action: row.state === "RECEIVED" ? command.type : null,
    };
  }
  receive(command: CommandMessage, timestamp: string): StoredCommand | null {
    if (command.schemaVersion !== 2 || command.deviceId !== this.deviceId)
      return null;
    const now = this.time(timestamp);
    const normalized = {
      ...commandMessageSchema.parse(command),
      commandId: command.commandId.toLowerCase(),
    };
    const json = JSON.stringify(normalized);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.find(command.commandId);
      if (existing !== undefined) {
        if (existing.command_json !== json)
          throw new Error("commandId content conflict");
        this.db
          .prepare(
            "UPDATE command_history SET ack_pending=1 WHERE device_id=? AND command_id=?",
          )
          .run(this.deviceId, normalized.commandId);
        this.db.exec("COMMIT");
        return this.result(existing);
      }
      this.db
        .prepare(
          "DELETE FROM command_history WHERE device_id=? AND expires_at <= ? AND state <> 'RECEIVED' AND state <> 'STARTED'",
        )
        .run(this.deviceId, now - this.retentionMs);
      let count = (
        this.db
          .prepare(
            "SELECT count(*) AS count FROM command_history WHERE device_id=?",
          )
          .get(this.deviceId) as { count: number }
      ).count;
      while (count >= this.maxRows) {
        const removed = this.db
          .prepare(
            "DELETE FROM command_history WHERE device_id=? AND command_id IN (SELECT command_id FROM command_history WHERE device_id=? AND expires_at <= ? AND state <> 'RECEIVED' AND state <> 'STARTED' ORDER BY expires_at, command_id LIMIT 1)",
          )
          .run(this.deviceId, this.deviceId, now).changes;
        if (removed === 0)
          throw new Error(
            "command history is full; unexpired history cannot be removed",
          );
        count -= 1;
      }
      const expired = now >= Date.parse(command.expiresAt);
      const ack: CommandAcknowledgementMessage = {
        schemaVersion: 2,
        commandId: normalized.commandId,
        deviceId: this.deviceId,
        timestamp,
        status: expired ? "REJECTED_EXPIRED" : "ACKNOWLEDGED",
      };
      this.db
        .prepare(
          "INSERT INTO command_history (device_id, command_id, command_json, expires_at, received_at, accepted_at, state, ack_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          this.deviceId,
          normalized.commandId,
          json,
          Date.parse(command.expiresAt),
          timestamp,
          expired ? null : timestamp,
          expired ? "EXPIRED" : "RECEIVED",
          JSON.stringify(commandAcknowledgementMessageSchema.parse(ack)),
        );
      this.db.exec("COMMIT");
      return { acknowledgement: ack, action: expired ? null : command.type };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  begin(id: string, timestamp: string): StoredCommand | null {
    const now = this.time(timestamp);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.find(id);
      if (row === undefined) {
        this.db.exec("COMMIT");
        return null;
      }
      const result = this.result(row);
      if (row.state === "RECEIVED") {
        const command = commandMessageSchema.parse(
          JSON.parse(row.command_json),
        );
        if (command.schemaVersion !== 2) throw new Error("v2 required");
        if (now >= Date.parse(command.expiresAt)) {
          result.action = null;
          result.acknowledgement = {
            ...result.acknowledgement,
            schemaVersion: 2,
            status: "REJECTED_EXPIRED",
            timestamp,
          };
          this.db
            .prepare(
              "UPDATE command_history SET state='EXPIRED', processed_at=?, ack_json=?, ack_pending=1 WHERE device_id=? AND command_id=?",
            )
            .run(
              timestamp,
              JSON.stringify(result.acknowledgement),
              this.deviceId,
              id.toLowerCase(),
            );
        } else {
          this.db
            .prepare(
              "UPDATE command_history SET state='STARTED', started_at=? WHERE device_id=? AND command_id=?",
            )
            .run(timestamp, this.deviceId, id.toLowerCase());
        }
      }
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  complete(id: string, timestamp: string): void {
    this.db
      .prepare(
        "UPDATE command_history SET state='COMPLETED', processed_at=? WHERE device_id=? AND command_id=? AND state='STARTED'",
      )
      .run(timestamp, this.deviceId, id.toLowerCase());
  }
  recover(timestamp: string): StoredCommand[] {
    this.time(timestamp);
    const rows = this.db
      .prepare(
        "SELECT command_json, ack_json, state FROM command_history WHERE device_id=? AND state='RECEIVED' ORDER BY received_at, command_id",
      )
      .all(this.deviceId) as unknown as Row[];
    return rows.map((row) => this.result(row));
  }
  pendingAcknowledgements(): CommandAcknowledgementMessage[] {
    return (
      this.db
        .prepare(
          "SELECT ack_json FROM command_history WHERE device_id=? AND ack_pending=1 ORDER BY received_at, command_id",
        )
        .all(this.deviceId) as Array<{ ack_json: string }>
    ).map(({ ack_json }) =>
      commandAcknowledgementMessageSchema.parse(JSON.parse(ack_json)),
    );
  }
  confirmAcknowledgement(ack: CommandAcknowledgementMessage): void {
    this.db
      .prepare(
        "UPDATE command_history SET ack_pending=0 WHERE device_id=? AND command_id=? AND ack_json=?",
      )
      .run(
        this.deviceId,
        ack.commandId.toLowerCase(),
        JSON.stringify(commandAcknowledgementMessageSchema.parse(ack)),
      );
  }
  history(): Array<
    Row & {
      command_id: string;
      started_at: string | null;
      processed_at: string | null;
    }
  > {
    return this.db
      .prepare(
        "SELECT * FROM command_history WHERE device_id=? ORDER BY received_at, command_id",
      )
      .all(this.deviceId) as unknown as Array<
      Row & {
        command_id: string;
        started_at: string | null;
        processed_at: string | null;
      }
    >;
  }
  close(): void {
    this.db.close();
  }
}

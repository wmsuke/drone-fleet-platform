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
  state:
    | "RECEIVED"
    | "STARTED"
    | "COMPLETED"
    | "FAILED"
    | "EXPIRED"
    | "UNCERTAIN";
  started_at?: string | null;
  execution_json?: string | null;
  ack_revision?: number;
}

export class CommandStore {
  private readonly db: DatabaseSync;
  private readonly maxRows: number;
  private readonly retentionMs: number;
  private lastTime = -Infinity;
  // 世代はwire payloadへ含めず、送信待ちから取得した通知オブジェクトに対応付ける。
  private readonly publications = new WeakMap<
    CommandAcknowledgementMessage,
    { execution: boolean; revision: number }
  >();
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
      const columns = this.db
        .prepare("PRAGMA table_info(command_history)")
        .all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "execution_json"))
        this.db.exec(
          "ALTER TABLE command_history ADD COLUMN execution_json TEXT",
        );
      if (!columns.some((column) => column.name === "execution_pending"))
        this.db.exec(
          "ALTER TABLE command_history ADD COLUMN execution_pending INTEGER NOT NULL DEFAULT 0",
        );
      for (const column of ["ack_revision", "execution_revision"])
        if (!columns.some((item) => item.name === column))
          this.db.exec(
            `ALTER TABLE command_history ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`,
          );
      const interrupted = this.db
        .prepare(
          "SELECT command_id, started_at FROM command_history WHERE device_id=? AND state='STARTED'",
        )
        .all(deviceId) as Array<{ command_id: string; started_at: string }>;
      for (const row of interrupted)
        this.finish(
          row.command_id,
          new Date(
            Math.max(Date.now(), Date.parse(row.started_at)),
          ).toISOString(),
          "UNCERTAIN",
        );
      if (interrupted.length > 0)
        console.warn(
          "停止前に開始したコマンドの結果が不明です。自動再実行しません",
          { deviceId, count: interrupted.length, state: "UNCERTAIN" },
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
  hasUnfinished(): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM command_history WHERE device_id=? AND state IN ('RECEIVED','STARTED','UNCERTAIN') LIMIT 1",
        )
        .get(this.deviceId) !== undefined
    );
  }
  private find(id: string): Row | undefined {
    return this.db
      .prepare(
        "SELECT command_json, ack_json, state, started_at, execution_json, ack_revision FROM command_history WHERE device_id=? AND command_id=?",
      )
      .get(this.deviceId, id.toLowerCase()) as unknown as Row | undefined;
  }
  private result(row: Row): StoredCommand {
    const command = commandMessageSchema.parse(JSON.parse(row.command_json));
    const ack = commandAcknowledgementMessageSchema.parse(
      JSON.parse(row.ack_json),
    );
    this.publications.set(ack, {
      execution: false,
      revision: row.ack_revision ?? 0,
    });
    return {
      acknowledgement: ack,
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
            "UPDATE command_history SET ack_pending=1, ack_revision=ack_revision+1, execution_pending=CASE WHEN execution_json IS NULL THEN 0 ELSE 1 END, execution_revision=execution_revision+1 WHERE device_id=? AND command_id=?",
          )
          .run(this.deviceId, normalized.commandId);
        this.db.exec("COMMIT");
        return this.result({
          ...existing,
          ack_revision: (existing.ack_revision ?? 0) + 1,
        });
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
      this.publications.set(ack, { execution: false, revision: 0 });
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
              "UPDATE command_history SET state='EXPIRED', processed_at=?, ack_json=?, ack_pending=1, ack_revision=ack_revision+1 WHERE device_id=? AND command_id=?",
            )
            .run(
              timestamp,
              JSON.stringify(result.acknowledgement),
              this.deviceId,
              id.toLowerCase(),
            );
          this.publications.set(result.acknowledgement, {
            execution: false,
            revision: (row.ack_revision ?? 0) + 1,
          });
        } else {
          this.db
            .prepare(
              "UPDATE command_history SET state='STARTED', started_at=? WHERE device_id=? AND command_id=?",
            )
            .run(timestamp, this.deviceId, id.toLowerCase());
          this.saveExecution(id, timestamp, timestamp, "RUNNING");
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
    this.finish(id, timestamp, "SUCCEEDED");
  }
  private saveExecution(
    id: string,
    timestamp: string,
    startedAt: string,
    status: "RUNNING" | "SUCCEEDED" | "FAILED" | "UNCERTAIN",
  ) {
    const notification = commandAcknowledgementMessageSchema.parse({
      schemaVersion: 3,
      deviceId: this.deviceId,
      commandId: id.toLowerCase(),
      timestamp,
      startedAt,
      status,
    });
    this.db
      .prepare(
        "UPDATE command_history SET execution_json=?, execution_pending=1, execution_revision=execution_revision+1 WHERE device_id=? AND command_id=?",
      )
      .run(JSON.stringify(notification), this.deviceId, id.toLowerCase());
  }
  finish(
    id: string,
    timestamp: string,
    status: "SUCCEEDED" | "FAILED" | "UNCERTAIN",
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.find(id);
      if (row?.state === "STARTED" && row.started_at) {
        this.saveExecution(id, timestamp, row.started_at, status);
        this.db
          .prepare(
            "UPDATE command_history SET state=?, processed_at=? WHERE device_id=? AND command_id=?",
          )
          .run(
            status === "SUCCEEDED" ? "COMPLETED" : status,
            status === "UNCERTAIN" ? null : timestamp,
            this.deviceId,
            id.toLowerCase(),
          );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  recover(timestamp: string): StoredCommand[] {
    this.time(timestamp);
    const rows = this.db
      .prepare(
        "SELECT command_json, ack_json, state, ack_revision FROM command_history WHERE device_id=? AND state='RECEIVED' ORDER BY received_at, command_id",
      )
      .all(this.deviceId) as unknown as Row[];
    return rows.map((row) => this.result(row));
  }
  pendingAcknowledgements(): CommandAcknowledgementMessage[] {
    return (
      this.db
        .prepare(
          "SELECT ack_json, ack_revision FROM command_history WHERE device_id=? AND ack_pending=1 ORDER BY received_at, command_id",
        )
        .all(this.deviceId) as Array<{ ack_json: string; ack_revision: number }>
    ).map(({ ack_json, ack_revision }) => {
      const ack = commandAcknowledgementMessageSchema.parse(
        JSON.parse(ack_json),
      );
      this.publications.set(ack, { execution: false, revision: ack_revision });
      return ack;
    });
  }
  pendingExecutions(): CommandAcknowledgementMessage[] {
    return (
      this.db
        .prepare(
          "SELECT execution_json, execution_revision FROM command_history WHERE device_id=? AND execution_pending=1 ORDER BY received_at, command_id",
        )
        .all(this.deviceId) as Array<{
        execution_json: string;
        execution_revision: number;
      }>
    ).map((row) => {
      const ack = commandAcknowledgementMessageSchema.parse(
        JSON.parse(row.execution_json),
      );
      this.publications.set(ack, {
        execution: true,
        revision: row.execution_revision,
      });
      return ack;
    });
  }
  confirmAcknowledgement(ack: CommandAcknowledgementMessage): void {
    const publication = this.publications.get(ack);
    if (!publication) return;
    if (publication.execution) {
      this.db
        .prepare(
          "UPDATE command_history SET execution_pending=0 WHERE device_id=? AND command_id=? AND execution_json=? AND execution_revision=?",
        )
        .run(
          this.deviceId,
          ack.commandId.toLowerCase(),
          JSON.stringify(commandAcknowledgementMessageSchema.parse(ack)),
          publication.revision,
        );
      return;
    }
    this.db
      .prepare(
        "UPDATE command_history SET ack_pending=0 WHERE device_id=? AND command_id=? AND ack_json=? AND ack_revision=?",
      )
      .run(
        this.deviceId,
        ack.commandId.toLowerCase(),
        JSON.stringify(commandAcknowledgementMessageSchema.parse(ack)),
        publication.revision,
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

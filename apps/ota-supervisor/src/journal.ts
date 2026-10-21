import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import {
  canonical,
  envelopeSchema,
  type Envelope,
} from "@drone-fleet/releases";
import {
  otaRequestMessageSchema,
  otaEventMessageSchema,
  otaReceiptMessageSchema,
  serializeOtaEvent,
  type OtaRequestMessage,
  type OtaApplyRequest,
  type OtaEventMessage,
  type OtaReceiptMessage,
} from "@drone-fleet/protocol";
import { z } from "zod";

export class OtaError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
  }
}
const modelSchema = z
  .object({
    deviceId: z.string(),
    highestFence: z.string(),
    active: envelopeSchema,
    knownGood: envelopeSchema,
    apply: otaRequestMessageSchema.nullable(),
    phase: z.enum([
      "IDLE",
      "RECEIVED",
      "DOWNLOADING",
      "VERIFIED",
      "QUIESCING",
      "SWITCHING",
      "BOOTING",
      "HEALTH_CHECKING",
      "APPLIED",
      "FAILED",
      "STOPPED",
      "UNCERTAIN",
    ]),
    candidate: envelopeSchema.nullable(),
    from: envelopeSchema.nullable(),
    childPid: z.number().nullable(),
    launching: z.boolean(),
    downloadedBytes: z.number(),
    downloadAttempts: z.number(),
    downloadStartedAt: z.number().nullable(),
    health: z
      .object({
        count: z.number(),
        startedMs: z.number(),
        lastMs: z.number(),
        supervisorBootId: z.string(),
        bootId: z.string(),
      })
      .nullable(),
    fault: z.string().nullable(),
  })
  .strict();
export type Model = z.infer<typeof modelSchema>;
export type EventDetails = OtaEventMessage extends infer E
  ? E extends OtaEventMessage
    ? Omit<
        E,
        | "schemaVersion"
        | "deviceId"
        | "deploymentId"
        | "stageId"
        | "targetId"
        | "attemptId"
        | "fence"
        | "release"
        | "eventId"
        | "sequence"
        | "timestamp"
        | "applyCommandId"
        | "supervisorBootId"
      >
    : never
  : never;
export class Journal {
  private depth = 0;
  private db: DatabaseSync;
  readonly bootId = randomUUID();
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS model (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (command_id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, sequence INTEGER NOT NULL, json TEXT NOT NULL, hash TEXT NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0, UNIQUE(attempt_id,sequence));
      CREATE TABLE IF NOT EXISTS stops (attempt_id TEXT PRIMARY KEY, fence TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS health_samples (event_id TEXT PRIMARY KEY, json TEXT NOT NULL);`);
    const check = this.db.prepare("PRAGMA quick_check").get() as {
      quick_check: string;
    };
    if (check.quick_check !== "ok") throw new OtaError("JOURNAL_CORRUPT");
  }
  initialize(deviceId: string, active: Envelope) {
    if (this.exists()) throw new OtaError("JOURNAL_ALREADY_EXISTS");
    const model: Model = {
      deviceId,
      highestFence: "0",
      active,
      knownGood: active,
      apply: null,
      phase: "IDLE",
      candidate: null,
      from: null,
      childPid: null,
      launching: false,
      downloadedBytes: 0,
      downloadAttempts: 0,
      downloadStartedAt: null,
      health: null,
      fault: null,
    };
    this.db
      .prepare("INSERT INTO model VALUES(1,?)")
      .run(JSON.stringify(modelSchema.parse(model)));
  }
  exists() {
    return (
      this.db.prepare("SELECT 1 FROM model WHERE id=1").get() !== undefined
    );
  }
  read(): Model {
    const row = this.db.prepare("SELECT json FROM model WHERE id=1").get() as
      | { json: string }
      | undefined;
    if (!row) throw new OtaError("BOOTSTRAP_REQUIRED");
    return modelSchema.parse(JSON.parse(row.json));
  }
  change(
    patch: Partial<Model>,
    details?: EventDetails,
    source?: OtaApplyRequest,
  ): OtaEventMessage | undefined {
    return this.transaction(() => {
      const model = modelSchema.parse({ ...this.read(), ...patch });
      let event: OtaEventMessage | undefined;
      const apply = source ?? model.apply;
      if (details) {
        if (!apply || apply.type !== "APPLY_RELEASE")
          throw new OtaError("UNKNOWN_ATTEMPT");
        this.ensureCapacity();
        const { max } = this.db
          .prepare("SELECT MAX(sequence) AS max FROM events WHERE attempt_id=?")
          .get(apply.attemptId) as { max: number | null };
        event = otaEventMessageSchema.parse({
          schemaVersion: 1,
          deviceId: apply.deviceId,
          deploymentId: apply.deploymentId,
          stageId: apply.stageId,
          targetId: apply.targetId,
          attemptId: apply.attemptId,
          fence: apply.fence,
          release: apply.release,
          eventId: randomUUID(),
          sequence: (max ?? -1) + 1,
          applyCommandId: apply.commandId,
          supervisorBootId: this.bootId,
          timestamp: new Date().toISOString(),
          ...details,
        });
        const json = serializeOtaEvent(event);
        const hash = createHash("sha256").update(json).digest("hex");
        this.db
          .prepare(
            "INSERT INTO events(event_id,attempt_id,sequence,json,hash) VALUES(?,?,?,?,?)",
          )
          .run(event.eventId, event.attemptId, event.sequence, json, hash);
      }
      this.db
        .prepare("UPDATE model SET json=? WHERE id=1")
        .run(JSON.stringify(model));
      return event;
    });
  }
  transaction<T>(fn: () => T): T {
    if (this.depth) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.depth--;
    }
  }
  previousAttempt(id: string) {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM requests WHERE json_extract(json,'$.type')='APPLY_RELEASE' AND json_extract(json,'$.attemptId')=? LIMIT 1",
        )
        .get(id) !== undefined
    );
  }
  remember(request: OtaRequestMessage): boolean {
    const json = canonical(request);
    const old = this.db
      .prepare("SELECT json FROM requests WHERE command_id=?")
      .get(request.commandId) as { json: string } | undefined;
    if (old) {
      if (old.json !== json) throw new OtaError("COMMAND_CONFLICT");
      return false;
    }
    this.ensureCapacity();
    if (
      (
        this.db.prepare("SELECT COUNT(*) AS count FROM requests").get() as {
          count: number;
        }
      ).count >= 10000
    )
      throw new OtaError("CAPACITY_EXCEEDED");
    this.db
      .prepare("INSERT INTO requests VALUES(?,?)")
      .run(request.commandId, json);
    return true;
  }
  replay(request: OtaRequestMessage) {
    const row = this.db
      .prepare("SELECT json FROM requests WHERE command_id=?")
      .get(request.commandId) as { json: string } | undefined;
    if (row && row.json !== canonical(request))
      throw new OtaError("COMMAND_CONFLICT");
    return !!row;
  }
  stopped(attemptId: string) {
    return (
      this.db
        .prepare("SELECT 1 FROM stops WHERE attempt_id=?")
        .get(attemptId) !== undefined
    );
  }
  stop(attemptId: string, fence: string) {
    this.db
      .prepare("INSERT OR IGNORE INTO stops VALUES(?,?)")
      .run(attemptId, fence);
  }
  pending() {
    return this.db
      .prepare(
        "SELECT json,hash FROM events WHERE confirmed=0 ORDER BY rowid LIMIT 1",
      )
      .get() as { json: string; hash: string } | undefined;
  }
  confirmedAttempt(attemptId: string) {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM events WHERE attempt_id=? AND confirmed=1 LIMIT 1",
        )
        .get(attemptId) !== undefined
    );
  }
  events() {
    return (
      this.db.prepare("SELECT json FROM events ORDER BY rowid").all() as Array<{
        json: string;
      }>
    ).map((r) => otaEventMessageSchema.parse(JSON.parse(r.json)));
  }
  sample(patch: Partial<Model>, probe: unknown) {
    this.transaction(() => {
      this.ensureCapacity();
      this.db.prepare("INSERT INTO health_samples VALUES(?,?)").run(
        randomUUID(),
        JSON.stringify({
          attemptId: this.read().apply?.attemptId,
          releaseId: this.read().active.manifest.releaseId,
          probe,
          timestamp: new Date().toISOString(),
          health: patch.health,
        }),
      );
      this.change(patch);
    });
  }
  confirm(input: unknown): boolean {
    const parsed = otaReceiptMessageSchema.safeParse(input);
    if (!parsed.success) return false;
    const r: OtaReceiptMessage = parsed.data;
    const row = this.db
      .prepare("SELECT json,hash,confirmed FROM events WHERE event_id=?")
      .get(r.eventId) as
      | { json: string; hash: string; confirmed: number }
      | undefined;
    if (!row || row.hash !== r.payloadHash || row.confirmed) return false;
    const e = otaEventMessageSchema.parse(JSON.parse(row.json));
    if (
      e.deviceId !== r.deviceId ||
      e.deploymentId !== r.deploymentId ||
      e.stageId !== r.stageId ||
      e.targetId !== r.targetId ||
      e.attemptId !== r.attemptId ||
      e.fence !== r.fence ||
      canonical(e.release) !== canonical(r.release)
    )
      return false;
    this.db
      .prepare("UPDATE events SET confirmed=1 WHERE event_id=?")
      .run(r.eventId);
    return true;
  }
  ensureCapacity() {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(json AS BLOB))),0) AS bytes FROM (SELECT json FROM events UNION ALL SELECT json FROM health_samples)",
      )
      .get() as { count: number; bytes: number };
    if (row.count >= 9950 || row.bytes > 32 * 1024 * 1024 - 65536)
      throw new OtaError("CAPACITY_EXCEEDED");
  }
  close() {
    this.db.close();
  }
}

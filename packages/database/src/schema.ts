import { sql } from "drizzle-orm";
import {
  bigserial,
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  text,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  timestamp,
  uuid,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export const connectionStatusEnum = pgEnum("connection_status", [
  "ONLINE",
  "OFFLINE",
]);
export const flightStatusEnum = pgEnum("flight_status", [
  "IDLE",
  "FLYING",
  "RETURNING_HOME",
]);
export const commandTypeEnum = pgEnum("command_type", [
  "RETURN_HOME",
  "REBOOT",
]);
export const commandStatusEnum = pgEnum("command_status", [
  "PENDING",
  "SENT",
  "ACKNOWLEDGED",
  "FAILED",
  "TIMED_OUT",
  "EXPIRED",
]);

export const devices = pgTable(
  "devices",
  {
    deviceId: varchar("device_id", { length: 64 }).notNull(),
    model: varchar("model", { length: 100 }),
    softwareVersion: varchar("software_version", { length: 100 }),
    connectionStatus: connectionStatusEnum("connection_status")
      .notNull()
      .default("OFFLINE"),
    lastReceivedAt: timestamp("last_received_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.deviceId] })],
);

export const telemetry = pgTable(
  "telemetry",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    deviceId: varchar("device_id", { length: 64 })
      .notNull()
      .references(() => devices.deviceId, { onDelete: "cascade" }),
    sessionId: uuid("session_id"),
    identityOwner: boolean("identity_owner").notNull().default(true),
    sourcePayload: jsonb("source_payload").$type<Record<string, unknown>>(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    deviceTimestamp: timestamp("device_timestamp", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    receivedAt: timestamp("received_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    battery: real("battery").notNull(),
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
    altitude: doublePrecision("altitude").notNull(),
    temperature: doublePrecision("temperature").notNull(),
    flightStatus: flightStatusEnum("flight_status").notNull(),
  },
  (table) => [
    uniqueIndex("telemetry_identity_idx")
      .on(table.deviceId, table.sessionId, table.sequence)
      .where(sql`${table.sessionId} is not null and ${table.identityOwner}`),
    index("telemetry_device_sequence_idx").on(table.deviceId, table.sequence),
    index("telemetry_device_received_at_idx").on(
      table.deviceId,
      table.receivedAt.desc(),
    ),
    check("telemetry_sequence_non_negative", sql`${table.sequence} >= 0`),
    check(
      "telemetry_battery_range",
      sql`${table.battery} >= 0 AND ${table.battery} <= 100`,
    ),
    check(
      "telemetry_latitude_range",
      sql`${table.latitude} >= -90 AND ${table.latitude} <= 90`,
    ),
    check(
      "telemetry_longitude_range",
      sql`${table.longitude} >= -180 AND ${table.longitude} <= 180`,
    ),
    check(
      "telemetry_altitude_finite_non_negative",
      sql`${table.altitude} >= 0 AND ${table.altitude} < 'Infinity'::double precision`,
    ),
    check(
      "telemetry_temperature_finite",
      sql`${table.temperature} > '-Infinity'::double precision AND ${table.temperature} < 'Infinity'::double precision`,
    ),
  ],
);

export const commands = pgTable(
  "commands",
  {
    commandId: uuid("command_id").primaryKey(),
    deviceId: varchar("device_id", { length: 64 })
      .notNull()
      .references(() => devices.deviceId, { onDelete: "restrict" }),
    type: commandTypeEnum("type").notNull(),
    status: commandStatusEnum("status").notNull().default("PENDING"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    expiredAt: timestamp("expired_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
    acknowledgementReceivedAt: timestamp("acknowledgement_received_at", {
      withTimezone: true,
      mode: "date",
    }),
    timedOutAt: timestamp("timed_out_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (table) => [
    index("commands_device_created_at_idx").on(
      table.deviceId,
      table.createdAt.desc(),
    ),
    index("commands_status_created_at_idx").on(table.status, table.createdAt),
    check(
      "commands_acknowledged_at_required",
      sql`${table.status} <> 'ACKNOWLEDGED' OR ${table.acknowledgementReceivedAt} IS NOT NULL`,
    ),
  ],
);

export const commandOutbox = pgTable(
  "command_outbox",
  {
    commandId: uuid("command_id")
      .primaryKey()
      .references(() => commands.commandId, { onDelete: "cascade" }),
    topic: text("topic").notNull(),
    payload: text("payload").notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    failures: integer("failures").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    state: text("state").notNull().default("PENDING"),
    publishedAt: timestamp("published_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (table) => [
    index("command_outbox_due_idx").on(table.state, table.nextAttemptAt),
    check(
      "command_outbox_state",
      sql`${table.state} IN ('PENDING', 'WAITING_ACK', 'ACKNOWLEDGED', 'FAILED', 'EXPIRED', 'TIMED_OUT')`,
    ),
    check(
      "command_outbox_counts",
      sql`${table.attempts} >= 0 AND ${table.failures} >= 0 AND ${table.failures} <= ${table.attempts}`,
    ),
  ],
);
export type Device = typeof devices.$inferSelect;
export type NewDevice = typeof devices.$inferInsert;
export type Telemetry = typeof telemetry.$inferSelect;
export type NewTelemetry = typeof telemetry.$inferInsert;
export type Command = typeof commands.$inferSelect;
export type NewCommand = typeof commands.$inferInsert;

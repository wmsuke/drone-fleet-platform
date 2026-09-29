import { sql } from "drizzle-orm";
import {
  bigserial,
  bigint,
  check,
  doublePrecision,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  timestamp,
  uuid,
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

export type Device = typeof devices.$inferSelect;
export type NewDevice = typeof devices.$inferInsert;
export type Telemetry = typeof telemetry.$inferSelect;
export type NewTelemetry = typeof telemetry.$inferInsert;
export type Command = typeof commands.$inferSelect;
export type NewCommand = typeof commands.$inferInsert;

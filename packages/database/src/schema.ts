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

export const auditLogs = pgTable(
  "audit_logs",
  {
    eventId: uuid("event_id").primaryKey(),
    schemaVersion: integer("schema_version").notNull().default(1),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`clock_timestamp()`),
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    targetKind: text("target_kind").notNull(),
    targetId: varchar("target_id", { length: 128 }),
    result: text("result").notNull(),
    requestId: uuid("request_id"),
    groupId: uuid("group_id"),
    operationId: uuid("operation_id"),
    commandId: uuid("command_id"),
    alertId: uuid("alert_id"),
    metadata: jsonb("metadata")
      .$type<Record<string, string | number | boolean | null>>()
      .notNull()
      .default({}),
  },
  (t) => [
    index("audit_logs_occurred_idx").on(t.occurredAt.desc(), t.eventId.desc()),
    index("audit_logs_actor_time_idx").on(
      t.actorKind,
      t.actorId,
      t.occurredAt.desc(),
      t.eventId.desc(),
    ),
    index("audit_logs_action_time_idx").on(
      t.action,
      t.occurredAt.desc(),
      t.eventId.desc(),
    ),
    index("audit_logs_result_time_idx").on(
      t.result,
      t.occurredAt.desc(),
      t.eventId.desc(),
    ),
    index("audit_logs_request_idx").on(t.requestId),
    index("audit_logs_operation_idx").on(t.operationId, t.occurredAt),
    index("audit_logs_command_idx").on(t.commandId, t.occurredAt),
    index("audit_logs_target_idx").on(t.targetKind, t.targetId, t.occurredAt),
    check(
      "audit_logs_actor_valid",
      sql`(${t.actorKind}='anonymous' AND ${t.actorId} IS NULL) OR (${t.actorKind}='system' AND ${t.actorId} IS NOT NULL AND ${t.actorId} IN ('telemetry-ingestor','alert-evaluator','operation-evaluator','ota-worker'))`,
    ),
    check(
      "audit_logs_result_valid",
      sql`${t.result} IN ('SUCCEEDED','REJECTED','FAILED')`,
    ),
    check(
      "audit_logs_target_valid",
      sql`${t.targetKind} IN ('group','device','command','operation','alert','release','deployment')`,
    ),
    check(
      "audit_logs_metadata_bounded",
      sql`jsonb_typeof(${t.metadata})='object' AND octet_length(${t.metadata}::text)<=8192`,
    ),
    check("audit_logs_version_valid", sql`${t.schemaVersion}=1`),
  ],
);

export const releases = pgTable(
  "releases",
  {
    releaseId: uuid("release_id").primaryKey(),
    application: text("application").notNull(),
    version: text("version").notNull(),
    platform: text("platform").notNull(),
    digest: varchar("digest", { length: 64 }).notNull(),
    envelope: jsonb("envelope").$type<Record<string, unknown>>().notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`clock_timestamp()`),
    verification: text("verification").notNull().default("VERIFIED"),
    actorKind: text("actor_kind").notNull().default("anonymous"),
    actorId: text("actor_id"),
  },
  (t) => [
    uniqueIndex("releases_application_version_platform_unique").on(
      t.application,
      t.version,
      t.platform,
    ),
    check("releases_verification_valid", sql`${t.verification}='VERIFIED'`),
    check(
      "releases_actor_valid",
      sql`${t.actorKind}='anonymous' AND ${t.actorId} IS NULL`,
    ),
    check("releases_digest_valid", sql`${t.digest} ~ '^[0-9a-f]{64}$'`),
  ],
);

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
    connectionChangedAt: timestamp("connection_changed_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    connectionRevision: integer("connection_revision").notNull().default(0),
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
    isRetained: boolean("is_retained").notNull().default(true),
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
    executionStatus: text("execution_status").notNull().default("NOT_REPORTED"),
    executionStartedAt: timestamp("execution_started_at", {
      withTimezone: true,
      mode: "date",
    }),
    executionStartedReceivedAt: timestamp("execution_started_received_at", {
      withTimezone: true,
      mode: "date",
    }),
    executionResultAt: timestamp("execution_result_at", {
      withTimezone: true,
      mode: "date",
    }),
    executionResultReceivedAt: timestamp("execution_result_received_at", {
      withTimezone: true,
      mode: "date",
    }),
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
    check(
      "commands_execution_status_valid",
      sql`${table.executionStatus} IN ('NOT_REPORTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'UNCERTAIN')`,
    ),
    check(
      "commands_execution_times_required",
      sql`${table.executionStatus} = 'NOT_REPORTED' OR (${table.executionStartedAt} IS NOT NULL AND ${table.executionStartedReceivedAt} IS NOT NULL AND ${table.expiresAt} IS NOT NULL AND ${table.executionStartedAt} >= ${table.createdAt} AND ${table.executionStartedAt} < ${table.expiresAt} AND (${table.executionStatus} = 'RUNNING' OR (${table.executionResultAt} IS NOT NULL AND ${table.executionResultReceivedAt} IS NOT NULL AND ${table.executionResultAt} >= ${table.executionStartedAt})))`,
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
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }),
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
export const groups = pgTable(
  "groups",
  {
    groupId: uuid("group_id").primaryKey(),
    name: varchar("name", { length: 100 }).notNull(),
    description: varchar("description", { length: 1000 }),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    index("groups_active_created_idx")
      .on(table.createdAt, table.groupId)
      .where(sql`${table.deletedAt} IS NULL`),
    check(
      "groups_name_valid",
      sql`length(btrim(${table.name})) BETWEEN 1 AND 100 AND ${table.name} = btrim(${table.name}) AND ${table.name} !~ '[[:cntrl:]]'`,
    ),
    check("groups_revision_positive", sql`${table.revision} > 0`),
  ],
);

export const groupMemberships = pgTable(
  "group_memberships",
  {
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.groupId, { onDelete: "restrict" }),
    deviceId: varchar("device_id", { length: 64 })
      .notNull()
      .references(() => devices.deviceId, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.groupId, table.deviceId] }),
    index("group_memberships_device_idx").on(table.deviceId, table.groupId),
  ],
);

export const commandExecutionEvents = pgTable(
  "command_execution_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    commandId: uuid("command_id")
      .notNull()
      .references(() => commands.commandId, { onDelete: "cascade" }),
    deviceId: varchar("device_id", { length: 64 }).notNull(),
    status: text("status").notNull(),
    deviceTimestamp: timestamp("device_timestamp", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    receivedAt: timestamp("received_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    disposition: text("disposition").notNull(),
  },
  (table) => [
    index("command_execution_events_command_idx").on(table.commandId, table.id),
    check(
      "command_execution_events_status_valid",
      sql`${table.status} IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'UNCERTAIN', 'REJECTED_EXPIRED')`,
    ),
    check(
      "command_execution_events_disposition_valid",
      sql`${table.disposition} IN ('applied', 'ignored', 'conflict')`,
    ),
  ],
);

export const fleetOperations = pgTable(
  "fleet_operations",
  {
    operationId: uuid("operation_id").primaryKey(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.groupId, { onDelete: "restrict" }),
    groupName: varchar("group_name", { length: 100 }).notNull(),
    groupRevision: integer("group_revision").notNull(),
    type: commandTypeEnum("type").notNull(),
    idempotencyScope: varchar("idempotency_scope", { length: 128 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    actorKind: text("actor_kind").notNull().default("anonymous"),
    targetCount: integer("target_count").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    resultDeadline: timestamp("result_deadline", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (table) => [
    uniqueIndex("fleet_operations_idempotency_idx").on(
      table.idempotencyScope,
      table.idempotencyKey,
    ),
    index("fleet_operations_group_created_idx").on(
      table.groupId,
      table.createdAt.desc(),
      table.operationId,
    ),
    check(
      "fleet_operations_counts_positive",
      sql`${table.targetCount} > 0 AND ${table.groupRevision} > 0`,
    ),
    check(
      "fleet_operations_deadlines",
      sql`${table.createdAt} < ${table.expiresAt} AND ${table.expiresAt} < ${table.resultDeadline}`,
    ),
    check(
      "fleet_operations_key_valid",
      sql`${table.idempotencyKey} ~ '^[A-Za-z0-9_-]{1,128}$'`,
    ),
    check(
      "fleet_operations_actor_anonymous",
      sql`${table.actorKind} = 'anonymous'`,
    ),
  ],
);

export const fleetOperationTargets = pgTable(
  "fleet_operation_targets",
  {
    operationId: uuid("operation_id")
      .notNull()
      .references(() => fleetOperations.operationId, { onDelete: "restrict" }),
    deviceId: varchar("device_id", { length: 64 })
      .notNull()
      .references(() => devices.deviceId, { onDelete: "restrict" }),
    commandId: uuid("command_id")
      .notNull()
      .references(() => commands.commandId, { onDelete: "restrict" }),
  },
  (table) => [
    primaryKey({ columns: [table.operationId, table.deviceId] }),
    uniqueIndex("fleet_operation_targets_command_idx").on(table.commandId),
    index("fleet_operation_targets_device_idx").on(
      table.deviceId,
      table.operationId,
    ),
  ],
);

export type Device = typeof devices.$inferSelect;
export const operationAuditStates = pgTable(
  "operation_audit_states",
  {
    operationId: uuid("operation_id")
      .primaryKey()
      .references(() => fleetOperations.operationId, { onDelete: "cascade" }),
    status: text("status").notNull(),
    evaluatedAt: timestamp("evaluated_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    firstFinishedAt: timestamp("first_finished_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (t) => [
    check(
      "operation_audit_states_status_valid",
      sql`${t.status} IN ('ACCEPTED','IN_PROGRESS','COMPLETED','PARTIALLY_FAILED','FAILED')`,
    ),
  ],
);
export type NewDevice = typeof devices.$inferInsert;
export type Telemetry = typeof telemetry.$inferSelect;
export type NewTelemetry = typeof telemetry.$inferInsert;
export type Command = typeof commands.$inferSelect;
export type NewCommand = typeof commands.$inferInsert;

export const deviceOnlineObservations = pgTable(
  "device_online_observations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    deviceId: varchar("device_id", { length: 64 })
      .notNull()
      .references(() => devices.deviceId, { onDelete: "cascade" }),
    deviceTimestamp: timestamp("device_timestamp", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    receivedAt: timestamp("received_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    uniqueIndex("online_observations_identity_idx").on(
      t.deviceId,
      t.deviceTimestamp,
    ),
    index("online_observations_received_idx").on(t.deviceId, t.receivedAt),
  ],
);

export const alerts = pgTable(
  "alerts",
  {
    alertId: uuid("alert_id").primaryKey(),
    deviceId: varchar("device_id", { length: 64 })
      .notNull()
      .references(() => devices.deviceId, { onDelete: "restrict" }),
    commandId: uuid("command_id").references(() => commands.commandId, {
      onDelete: "restrict",
    }),
    deduplicationKey: text("deduplication_key").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("ACTIVE"),
    severity: text("severity").notNull().default("warning"),
    reason: text("reason").notNull(),
    occurredAt: timestamp("occurred_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    lastObservedAt: timestamp("last_observed_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
    acknowledgedAt: timestamp("acknowledged_at", {
      withTimezone: true,
      mode: "date",
    }),
    acknowledgedActorKind: text("acknowledged_actor_kind"),
    acknowledgedActorId: text("acknowledged_actor_id"),
    ruleVersion: text("rule_version").notNull(),
    parameters: jsonb("parameters").$type<Record<string, number>>().notNull(),
    evidence: jsonb("evidence")
      .$type<Record<string, string | number | null>>()
      .notNull(),
  },
  (t) => [
    uniqueIndex("alerts_active_key_idx")
      .on(t.deduplicationKey)
      .where(sql`${t.status} = 'ACTIVE'`),
    uniqueIndex("alerts_command_once_idx")
      .on(t.commandId)
      .where(sql`${t.commandId} IS NOT NULL`),
    index("alerts_status_occurred_idx").on(t.status, t.occurredAt),
    check(
      "alerts_kind_valid",
      sql`${t.kind} IN ('OFFLINE','LOW_BATTERY','COMMAND_OUTCOME')`,
    ),
    check(
      "alerts_state_valid",
      sql`(${t.status} = 'ACTIVE' AND ${t.resolvedAt} IS NULL) OR (${t.status} = 'RESOLVED' AND ${t.resolvedAt} IS NOT NULL)`,
    ),
    check(
      "alerts_times_valid",
      sql`${t.lastObservedAt} >= ${t.occurredAt} AND (${t.resolvedAt} IS NULL OR ${t.resolvedAt} >= ${t.occurredAt})`,
    ),
    check("alerts_severity_valid", sql`${t.severity} = 'warning'`),
    check(
      "alerts_command_kind",
      sql`(${t.kind} = 'COMMAND_OUTCOME') = (${t.commandId} IS NOT NULL)`,
    ),
  ],
);
export const alertEvaluationStates = pgTable("alert_evaluation_states", {
  targetKey: text("target_key").primaryKey(),
  state: jsonb("state").$type<Record<string, unknown>>().notNull(),
  evaluatedAt: timestamp("evaluated_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
  ruleVersion: text("rule_version").notNull(),
});

// 未観測の旧simulatorには行を作らない。観測経路の実装は#170で追加する。
export const otaDeviceStates = pgTable(
  "ota_device_states",
  {
    deviceId: varchar("device_id", { length: 64 })
      .primaryKey()
      .references(() => devices.deviceId, { onDelete: "restrict" }),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    observedAt: timestamp("observed_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    highestFence: bigint("highest_fence", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    inventorySequence: bigint("inventory_sequence", { mode: "bigint" })
      .notNull()
      .default(sql`-1`),
  },
  (t) => [check("ota_device_fence_valid", sql`${t.highestFence} >= 0`)],
);

export const otaDeployments = pgTable(
  "ota_deployments",
  {
    deploymentId: uuid("deployment_id").primaryKey(),
    idempotencyScope: text("idempotency_scope").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    request: jsonb("request").$type<Record<string, unknown>>().notNull(),
    releaseId: uuid("release_id")
      .notNull()
      .references(() => releases.releaseId, { onDelete: "restrict" }),
    releaseSnapshot: jsonb("release_snapshot")
      .$type<Record<string, unknown>>()
      .notNull(),
    policy: jsonb("policy").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("ACCEPTED"),
    targetCount: integer("target_count").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    uniqueIndex("ota_deployment_key_unique").on(
      t.idempotencyScope,
      t.idempotencyKey,
    ),
    check(
      "ota_deployment_count_valid",
      sql`${t.targetCount} BETWEEN 1 AND 100`,
    ),
    check(
      "ota_deployment_scope_valid",
      sql`${t.idempotencyScope} = 'anonymous'`,
    ),
    check(
      "ota_deployment_status_valid",
      sql`${t.status} IN ('ACCEPTED','RUNNING','STOPPING','PAUSED','WAITING_FOR_HUMAN','COMPLETED','FAILED','CANCELLED')`,
    ),
  ],
);
export const otaStages = pgTable(
  "ota_stages",
  {
    stageId: uuid("stage_id").primaryKey(),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => otaDeployments.deploymentId, { onDelete: "restrict" }),
    position: integer("position").notNull(),
    status: text("status").notNull(),
    deviceIds: jsonb("device_ids").$type<string[]>().notNull(),
  },
  (t) => [
    uniqueIndex("ota_stage_position_unique").on(t.deploymentId, t.position),
    check("ota_stage_position_valid", sql`${t.position} BETWEEN 0 AND 9`),
    check(
      "ota_stage_status_valid",
      sql`${t.status} IN ('PENDING','RUNNING','AWAITING_APPROVAL','PASSED','STOPPING','PAUSED','FAILED')`,
    ),
  ],
);
export const otaTargets = pgTable(
  "ota_targets",
  {
    targetId: uuid("target_id").primaryKey(),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => otaDeployments.deploymentId, { onDelete: "restrict" }),
    stageId: uuid("stage_id")
      .notNull()
      .references(() => otaStages.stageId, { onDelete: "restrict" }),
    deviceId: varchar("device_id", { length: 64 })
      .notNull()
      .references(() => devices.deviceId, { onDelete: "restrict" }),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("QUEUED"),
  },
  (t) => [
    uniqueIndex("ota_target_device_unique").on(t.deploymentId, t.deviceId),
  ],
);
export const otaReservations = pgTable("ota_reservations", {
  deviceId: varchar("device_id", { length: 64 })
    .primaryKey()
    .references(() => devices.deviceId, { onDelete: "restrict" }),
  targetId: uuid("target_id")
    .notNull()
    .references(() => otaTargets.targetId, { onDelete: "restrict" }),
});
export const otaAttempts = pgTable(
  "ota_attempts",
  {
    attemptId: uuid("attempt_id").primaryKey(),
    targetId: uuid("target_id")
      .notNull()
      .references(() => otaTargets.targetId, { onDelete: "restrict" }),
    ordinal: integer("ordinal").notNull().default(1),
    commandId: uuid("command_id").notNull(),
    fence: bigint("fence", { mode: "bigint" }).notNull(),
    purpose: text("purpose").notNull().default("APPLY"),
    previousAttemptId: uuid("previous_attempt_id"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    resultDeadline: timestamp("result_deadline", {
      withTimezone: true,
      mode: "date",
    }),
    deliveryStatus: text("delivery_status").notNull().default("HELD"),
    applicationStatus: text("application_status"),
    evaluationStatus: text("evaluation_status").notNull().default("PENDING"),
  },
  (t) => [
    uniqueIndex("ota_attempt_command_unique").on(t.commandId),
    uniqueIndex("ota_attempt_ordinal_unique").on(t.targetId, t.ordinal),
    check("ota_attempt_fence_valid", sql`${t.fence} > 0`),
    check(
      "ota_attempt_purpose_valid",
      sql`${t.purpose} IN ('APPLY','ROLLBACK')`,
    ),
    check(
      "ota_attempt_times_valid",
      sql`(${t.startedAt} IS NULL AND ${t.expiresAt} IS NULL AND ${t.resultDeadline} IS NULL AND ${t.deliveryStatus}='HELD') OR (${t.startedAt} IS NOT NULL AND ${t.expiresAt}=${t.startedAt}+interval '300 seconds' AND ${t.resultDeadline}=${t.startedAt}+interval '600 seconds' AND ${t.deliveryStatus}<>'HELD')`,
    ),
  ],
);
export const otaOutbox = pgTable(
  "ota_outbox",
  {
    commandId: uuid("command_id")
      .primaryKey()
      .references(() => otaAttempts.commandId, { onDelete: "restrict" }),
    topic: text("topic").notNull(),
    payload: text("payload"),
    status: text("status").notNull().default("HELD"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    nextAttemptAt: timestamp("next_attempt_at", {
      withTimezone: true,
      mode: "date",
    }),
    attempts: integer("attempts").notNull().default(0),
  },
  (t) => [
    check(
      "ota_outbox_held_valid",
      sql`(${t.status}='HELD' AND ${t.payload} IS NULL AND ${t.expiresAt} IS NULL AND ${t.nextAttemptAt} IS NULL AND ${t.attempts}=0) OR (${t.status}<>'HELD' AND ${t.payload} IS NOT NULL AND ${t.expiresAt} IS NOT NULL)`,
    ),
  ],
);
// #170で採否・評価を追加するための受信事実。受付時には端末eventを捏造しない。
export const otaEvents = pgTable(
  "ota_events",
  {
    eventId: uuid("event_id").primaryKey(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => otaAttempts.attemptId, { onDelete: "restrict" }),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp("occurred_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    receivedAt: timestamp("received_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    storedAt: timestamp("stored_at", { withTimezone: true, mode: "date" })
      .notNull()
      .default(sql`clock_timestamp()`),
    acceptance: text("acceptance").notNull().default("UNPROCESSED"),
    reason: text("reason"),
    receipt: jsonb("receipt").$type<Record<string, unknown>>(),
  },
  (t) => [uniqueIndex("ota_event_sequence_unique").on(t.attemptId, t.sequence)],
);

export const otaRejections = pgTable(
  "ota_rejections",
  {
    rejectionId: uuid("rejection_id").primaryKey(),
    eventId: uuid("event_id").notNull(),
    attemptId: uuid("attempt_id"),
    deviceId: varchar("device_id", { length: 64 }).notNull(),
    payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    reason: text("reason").notNull(),
    receivedAt: timestamp("received_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    uniqueIndex("ota_rejection_once").on(t.eventId, t.payloadHash, t.reason),
    index("ota_rejection_attempt").on(t.attemptId),
  ],
);
export const otaQueries = pgTable(
  "ota_queries",
  {
    commandId: uuid("command_id").primaryKey(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => otaAttempts.attemptId, { onDelete: "restrict" }),
    challengeId: uuid("challenge_id"),
    expectedBootId: uuid("expected_boot_id"),
    expectedSupervisorBootId: uuid("expected_supervisor_boot_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    consumedEventId: uuid("consumed_event_id"),
  },
  (t) => [
    uniqueIndex("ota_query_challenge_unique").on(t.challengeId),
    index("ota_query_attempt_time").on(t.attemptId, t.createdAt),
  ],
);
export const otaEvaluations = pgTable(
  "ota_evaluations",
  {
    revision: bigserial("revision", { mode: "number" }).notNull(),
    evaluationId: uuid("evaluation_id").primaryKey(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => otaAttempts.attemptId, { onDelete: "restrict" }),
    specification: text("specification").notNull().default("ota-health-v1"),
    status: text("status").notNull(),
    reason: text("reason").notNull(),
    evidence: jsonb("evidence").$type<string[]>().notNull(),
    fingerprint: text("fingerprint").notNull(),
    evaluatedAt: timestamp("evaluated_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    uniqueIndex("ota_evaluation_once").on(t.attemptId, t.fingerprint),
    index("ota_evaluation_attempt_time").on(t.attemptId, t.evaluatedAt),
  ],
);
export const otaInventories = pgTable(
  "ota_inventories",
  {
    eventId: uuid("event_id").primaryKey(),
    deviceId: varchar("device_id", { length: 64 }).notNull(),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    payloadHash: text("payload_hash").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    reason: text("reason").notNull(),
    receipt: jsonb("receipt").$type<Record<string, unknown>>().notNull(),
    receivedAt: timestamp("received_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (t) => [
    uniqueIndex("ota_inventory_sequence_unique").on(t.deviceId, t.sequence),
  ],
);

// snapshotとは別の制御記録。stop latchは明示再開だけで解除する。
export const otaRollouts = pgTable("ota_rollouts", {
  deploymentId: uuid("deployment_id")
    .primaryKey()
    .references(() => otaDeployments.deploymentId, { onDelete: "restrict" }),
  stoppedAt: timestamp("stopped_at", { withTimezone: true, mode: "date" }),
  stopReason: text("stop_reason"),
});
export const otaActions = pgTable(
  "ota_actions",
  {
    actionId: uuid("action_id").primaryKey(),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => otaDeployments.deploymentId, { onDelete: "restrict" }),
    key: varchar("key", { length: 128 }).notNull(),
    requestHash: text("request_hash").notNull(),
    action: text("action").notNull(),
    reason: text("reason").notNull(),
    response: jsonb("response").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (t) => [uniqueIndex("ota_action_key_unique").on(t.deploymentId, t.key)],
);
export const otaDispatches = pgTable("ota_dispatches", {
  attemptId: uuid("attempt_id")
    .primaryKey()
    .references(() => otaAttempts.attemptId, { onDelete: "restrict" }),
  claimedAt: timestamp("claimed_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
});
export const otaStops = pgTable("ota_stops", {
  commandId: uuid("command_id").primaryKey(),
  attemptId: uuid("attempt_id")
    .notNull()
    .references(() => otaAttempts.attemptId, { onDelete: "restrict" })
    .unique(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
  expiresAt: timestamp("expires_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
  resultDeadline: timestamp("result_deadline", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
  nextAttemptAt: timestamp("next_attempt_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
  attempts: integer("attempts").notNull().default(0),
  confirmedEventId: uuid("confirmed_event_id"),
});

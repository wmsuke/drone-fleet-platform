CREATE TABLE "alert_evaluation_states" (
	"target_key" text PRIMARY KEY NOT NULL,
	"state" jsonb NOT NULL,
	"evaluated_at" timestamp with time zone NOT NULL,
	"rule_version" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"alert_id" uuid PRIMARY KEY NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"command_id" uuid,
	"deduplication_key" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"severity" text DEFAULT 'warning' NOT NULL,
	"reason" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"last_observed_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_actor_kind" text,
	"acknowledged_actor_id" text,
	"rule_version" text NOT NULL,
	"parameters" jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	CONSTRAINT "alerts_kind_valid" CHECK ("alerts"."kind" IN ('OFFLINE','LOW_BATTERY','COMMAND_OUTCOME')),
	CONSTRAINT "alerts_state_valid" CHECK (("alerts"."status" = 'ACTIVE' AND "alerts"."resolved_at" IS NULL) OR ("alerts"."status" = 'RESOLVED' AND "alerts"."resolved_at" IS NOT NULL)),
	CONSTRAINT "alerts_times_valid" CHECK ("alerts"."last_observed_at" >= "alerts"."occurred_at" AND ("alerts"."resolved_at" IS NULL OR "alerts"."resolved_at" >= "alerts"."occurred_at")),
	CONSTRAINT "alerts_severity_valid" CHECK ("alerts"."severity" = 'warning'),
	CONSTRAINT "alerts_command_kind" CHECK (("alerts"."kind" = 'COMMAND_OUTCOME') = ("alerts"."command_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "device_online_observations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"device_timestamp" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "connection_changed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "connection_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "telemetry" ADD COLUMN "is_retained" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_device_id_devices_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("device_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_command_id_commands_command_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."commands"("command_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_online_observations" ADD CONSTRAINT "device_online_observations_device_id_devices_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("device_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_active_key_idx" ON "alerts" USING btree ("deduplication_key") WHERE "alerts"."status" = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_command_once_idx" ON "alerts" USING btree ("command_id") WHERE "alerts"."command_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "alerts_status_occurred_idx" ON "alerts" USING btree ("status","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "online_observations_identity_idx" ON "device_online_observations" USING btree ("device_id","device_timestamp");--> statement-breakpoint
CREATE INDEX "online_observations_received_idx" ON "device_online_observations" USING btree ("device_id","received_at");
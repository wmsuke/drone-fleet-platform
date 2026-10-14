CREATE TABLE "fleet_operation_targets" (
	"operation_id" uuid NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"command_id" uuid NOT NULL,
	CONSTRAINT "fleet_operation_targets_operation_id_device_id_pk" PRIMARY KEY("operation_id","device_id")
);
--> statement-breakpoint
CREATE TABLE "fleet_operations" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"group_id" uuid NOT NULL,
	"group_name" varchar(100) NOT NULL,
	"group_revision" integer NOT NULL,
	"type" "command_type" NOT NULL,
	"idempotency_scope" varchar(128) NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"actor_kind" text DEFAULT 'anonymous' NOT NULL,
	"target_count" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"result_deadline" timestamp with time zone NOT NULL,
	CONSTRAINT "fleet_operations_counts_positive" CHECK ("fleet_operations"."target_count" > 0 AND "fleet_operations"."group_revision" > 0),
	CONSTRAINT "fleet_operations_deadlines" CHECK ("fleet_operations"."created_at" < "fleet_operations"."expires_at" AND "fleet_operations"."expires_at" < "fleet_operations"."result_deadline"),
	CONSTRAINT "fleet_operations_key_valid" CHECK ("fleet_operations"."idempotency_key" ~ '^[A-Za-z0-9_-]{1,128}$'),
	CONSTRAINT "fleet_operations_actor_anonymous" CHECK ("fleet_operations"."actor_kind" = 'anonymous')
);
--> statement-breakpoint
ALTER TABLE "fleet_operation_targets" ADD CONSTRAINT "fleet_operation_targets_operation_id_fleet_operations_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."fleet_operations"("operation_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_operation_targets" ADD CONSTRAINT "fleet_operation_targets_device_id_devices_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("device_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_operation_targets" ADD CONSTRAINT "fleet_operation_targets_command_id_commands_command_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."commands"("command_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_operations" ADD CONSTRAINT "fleet_operations_group_id_groups_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("group_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fleet_operation_targets_command_idx" ON "fleet_operation_targets" USING btree ("command_id");--> statement-breakpoint
CREATE INDEX "fleet_operation_targets_device_idx" ON "fleet_operation_targets" USING btree ("device_id","operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fleet_operations_idempotency_idx" ON "fleet_operations" USING btree ("idempotency_scope","idempotency_key");--> statement-breakpoint
CREATE INDEX "fleet_operations_group_created_idx" ON "fleet_operations" USING btree ("group_id","created_at" DESC NULLS LAST,"operation_id");
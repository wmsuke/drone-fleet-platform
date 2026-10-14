CREATE TABLE "command_execution_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"command_id" uuid NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"status" text NOT NULL,
	"device_timestamp" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"disposition" text NOT NULL,
	CONSTRAINT "command_execution_events_status_valid" CHECK ("command_execution_events"."status" IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'UNCERTAIN', 'REJECTED_EXPIRED')),
	CONSTRAINT "command_execution_events_disposition_valid" CHECK ("command_execution_events"."disposition" IN ('applied', 'ignored', 'conflict'))
);
--> statement-breakpoint
ALTER TABLE "commands" ADD COLUMN "execution_status" text DEFAULT 'NOT_REPORTED' NOT NULL;--> statement-breakpoint
ALTER TABLE "commands" ADD COLUMN "execution_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "commands" ADD COLUMN "execution_started_received_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "commands" ADD COLUMN "execution_result_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "commands" ADD COLUMN "execution_result_received_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "command_execution_events" ADD CONSTRAINT "command_execution_events_command_id_commands_command_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."commands"("command_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "command_execution_events_command_idx" ON "command_execution_events" USING btree ("command_id","id");--> statement-breakpoint
ALTER TABLE "commands" ADD CONSTRAINT "commands_execution_status_valid" CHECK ("commands"."execution_status" IN ('NOT_REPORTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'UNCERTAIN'));--> statement-breakpoint
ALTER TABLE "commands" ADD CONSTRAINT "commands_execution_times_required" CHECK ("commands"."execution_status" = 'NOT_REPORTED' OR ("commands"."execution_started_at" IS NOT NULL AND "commands"."execution_started_received_at" IS NOT NULL AND "commands"."expires_at" IS NOT NULL AND "commands"."execution_started_at" >= "commands"."created_at" AND "commands"."execution_started_at" < "commands"."expires_at" AND ("commands"."execution_status" = 'RUNNING' OR ("commands"."execution_result_at" IS NOT NULL AND "commands"."execution_result_received_at" IS NOT NULL AND "commands"."execution_result_at" >= "commands"."execution_started_at"))));
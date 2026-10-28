CREATE TABLE "ota_evaluations" (
	"evaluation_id" uuid PRIMARY KEY NOT NULL,
	"attempt_id" uuid NOT NULL,
	"specification" text DEFAULT 'ota-health-v1' NOT NULL,
	"status" text NOT NULL,
	"reason" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"evaluated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ota_inventories" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"sequence" bigint NOT NULL,
	"payload_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"reason" text NOT NULL,
	"receipt" jsonb NOT NULL,
	"received_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ota_queries" (
	"command_id" uuid PRIMARY KEY NOT NULL,
	"attempt_id" uuid NOT NULL,
	"challenge_id" uuid,
	"expected_boot_id" uuid,
	"expected_supervisor_boot_id" uuid,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"consumed_event_id" uuid
);
--> statement-breakpoint
CREATE TABLE "ota_rejections" (
	"rejection_id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"payload" jsonb NOT NULL,
	"reason" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ota_device_states" ADD COLUMN "inventory_sequence" bigint DEFAULT -1 NOT NULL;--> statement-breakpoint
ALTER TABLE "ota_events" ADD COLUMN "stored_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL;--> statement-breakpoint
ALTER TABLE "ota_events" ADD COLUMN "acceptance" text DEFAULT 'UNPROCESSED' NOT NULL;--> statement-breakpoint
ALTER TABLE "ota_events" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "ota_events" ADD COLUMN "receipt" jsonb;--> statement-breakpoint
ALTER TABLE "ota_evaluations" ADD CONSTRAINT "ota_evaluations_attempt_id_ota_attempts_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."ota_attempts"("attempt_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ota_queries" ADD CONSTRAINT "ota_queries_attempt_id_ota_attempts_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."ota_attempts"("attempt_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ota_evaluation_once" ON "ota_evaluations" USING btree ("attempt_id","fingerprint");--> statement-breakpoint
CREATE INDEX "ota_evaluation_attempt_time" ON "ota_evaluations" USING btree ("attempt_id","evaluated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ota_inventory_sequence_unique" ON "ota_inventories" USING btree ("device_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "ota_query_challenge_unique" ON "ota_queries" USING btree ("challenge_id");--> statement-breakpoint
CREATE INDEX "ota_query_attempt_time" ON "ota_queries" USING btree ("attempt_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ota_rejection_once" ON "ota_rejections" USING btree ("event_id","payload_hash","reason");--> statement-breakpoint
CREATE INDEX "ota_rejection_attempt" ON "ota_rejections" USING btree ("attempt_id");